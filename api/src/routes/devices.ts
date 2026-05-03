import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { addMqttUser, appendDeviceAcl, generateMqttPassword, reloadMosquitto, removeDeviceAcl, removeMqttUser } from '../lib/mosquitto.js';
import { hasActiveSub } from '../lib/stripe.js';

/** 6-character base32 (Crockford) — readable, no I/O/0/1 confusion. */
function generatePairingCode(): string {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const buf = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export async function registerDeviceRoutes(app: FastifyInstance) {
  const codeTtl = Number(process.env.PAIRING_CODE_TTL_SECONDS ?? 300);
  const brokerHost = process.env.MQTT_PUBLIC_HOST ?? 'mqtt.evolights.io';
  const brokerPort = Number(process.env.MQTT_PUBLIC_PORT ?? 8883);
  // The full root CA chain that the device must trust — pasted into wsec.json.
  // Loaded from a file at startup.
  let caCertPem = '';
  if (process.env.MQTT_CA_PEM_PATH) {
    try { caCertPem = require('node:fs').readFileSync(process.env.MQTT_CA_PEM_PATH, 'utf8'); }
    catch (e) { app.log.warn({ err: (e as Error).message }, 'could not read MQTT_CA_PEM_PATH'); }
  }

  // ------------------- App-side: issue a pairing code --------------------
  // POST /v1/pairing/codes  (auth: user; subscription: required)
  app.post('/v1/pairing/codes', { preHandler: app.requireUser }, async (req: any, reply) => {
    const sub = await app.db.query('select status from subscriptions where user_id=$1', [req.user.sub]);
    if (!sub.rowCount || !hasActiveSub(sub.rows[0].status)) {
      return reply.code(402).send({ error: 'subscription_required' });
    }

    // One-shot, expiring. Persist hashed for at-rest defense.
    const code = generatePairingCode();
    await app.db.query(
      `insert into pairing_codes (code, user_id, expires_at)
       values ($1, $2, now() + ($3 || ' seconds')::interval)
       on conflict (code) do update set user_id=excluded.user_id, expires_at=excluded.expires_at, used_at=null`,
      [code, req.user.sub, codeTtl],
    );
    return reply.send({
      code,
      expires_in: codeTtl,
      cloud_api: process.env.PUBLIC_API_URL ?? `https://api.evolights.io`,
    });
  });

  // ------------------- Device-side: redeem a pairing code -------------------
  // POST /v1/devices/redeem  (no JWT: device has no account; the code IS auth)
  // Body: { code, fw_version, chip_id }
  //
  // Concurrency model:
  //  - The pairing code is claimed atomically via a conditional UPDATE
  //    (used_at IS NULL AND expires_at > now()), eliminating the race window
  //    between SELECT and UPDATE that previously let two concurrent redeems
  //    both pass.
  //  - The hardware_id (chip_id) is attacker-supplied, so we explicitly
  //    refuse to silently re-assign a device already paired to a DIFFERENT
  //    user. (Previously an upsert on hardware_id would happily transfer
  //    ownership and rotate creds, kicking the legitimate owner off their
  //    own hardware — a free hijack for anyone with any valid pairing code.)
  //  - Everything below — code claim, device row, ACL file edit, broker
  //    reload — runs inside one Postgres transaction, with a Postgres
  //    advisory lock around the broker file ops to serialise concurrent
  //    redeems (the ACL/passwd files are read-modify-write text files that
  //    are NOT safe under concurrent edits across API replicas).
  //
  // Caveat: Mosquitto file writes are not literally rolled back if the DB
  // COMMIT fails after them. In practice that window is tiny (one COMMIT
  // round-trip) and a stranded broker user has no ACL match for any device
  // topic, so it cannot do anything until garbage-collected. Full atomicity
  // would require a custom mosquitto auth plugin reading directly from PG.
  app.post('/v1/devices/redeem', async (req, reply) => {
    const schema = z.object({
      code:       z.string().length(6),
      fw_version: z.string().min(1).max(32),
      chip_id:    z.string().min(1).max(64),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const { code, fw_version, chip_id } = parsed.data;

    const client = await app.db.connect();
    try {
      await client.query('begin');

      // Single atomic claim: UPDATE..RETURNING the user_id only if the code
      // is unused AND unexpired. Eliminates the SELECT/UPDATE race.
      const claim = await client.query<{ user_id: string }>(
        `update pairing_codes
            set used_at = now()
          where code = $1
            and used_at is null
            and expires_at > now()
          returning user_id`,
        [code],
      );
      if (!claim.rowCount) {
        await client.query('rollback');
        return reply.code(410).send({ error: 'code_expired_or_used' });
      }
      const userId: string = claim.rows[0].user_id;

      // Confirm the user still has an active subscription (codes are short
      // but a sub could have lapsed in the window).
      const sub = await client.query<{ status: string }>(
        'select status from subscriptions where user_id=$1', [userId],
      );
      if (!sub.rowCount || !hasActiveSub(sub.rows[0].status)) {
        await client.query('rollback');
        return reply.code(402).send({ error: 'subscription_inactive' });
      }

      // Look up any pre-existing device for this chip_id BEFORE writing.
      // Three branches:
      //   (a) exists & owned by THIS user            -> re-pair, rotate creds
      //   (b) exists & owned by a DIFFERENT user     -> 409, refuse hijack
      //   (c) does not exist                         -> insert
      // Critically we never UPSERT on hardware_id, because chip_id is
      // attacker-controllable.
      const existing = await client.query<{ id: string; user_id: string; mqtt_username: string }>(
        'select id, user_id, mqtt_username from devices where hardware_id = $1',
        [chip_id],
      );
      if (existing.rowCount && existing.rows[0].user_id !== userId) {
        await client.query('rollback');
        return reply.code(409).send({ error: 'device_already_paired_to_another_account' });
      }

      const mqttUser = `dev_${chip_id.toLowerCase()}_${crypto.randomBytes(4).toString('hex')}`;
      const mqttPass = generateMqttPassword();
      const mqttPassHash = await argon2.hash(mqttPass);

      let deviceId: string;
      let oldMqttUser: string | null = null;
      if (existing.rowCount) {
        // (a) Re-pair: same user, rotate MQTT creds. Capture the old username
        // so we can purge it from the broker after the new one is in place.
        oldMqttUser = existing.rows[0].mqtt_username;
        const upd = await client.query<{ id: string }>(
          `update devices
              set mqtt_username = $1,
                  mqtt_password_hash = $2,
                  firmware_version = $3
            where id = $4
            returning id`,
          [mqttUser, mqttPassHash, fw_version, existing.rows[0].id],
        );
        deviceId = upd.rows[0].id;
      } else {
        // (c) Fresh insert.
        const ins = await client.query<{ id: string }>(
          `insert into devices (user_id, name, hardware_id, mqtt_username, mqtt_password_hash, firmware_version)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [userId, `EvoLights ${chip_id.slice(-4).toUpperCase()}`, chip_id, mqttUser, mqttPassHash, fw_version],
        );
        deviceId = ins.rows[0].id;
      }

      await client.query(
        'update pairing_codes set device_id=$1 where code=$2',
        [deviceId, code],
      );

      // Serialise broker file edits across the cluster for the remainder of
      // this transaction. xact_lock auto-releases at COMMIT/ROLLBACK.
      await client.query("select pg_advisory_xact_lock(hashtext('mosquitto-provision'))");

      try {
        if (oldMqttUser) {
          // Best-effort cleanup of the previous broker entry. Failures here
          // would leave a stranded user with no ACL match, which is harmless
          // until next sweep; we don't want to abort the re-pair for it.
          await removeMqttUser(oldMqttUser).catch((e: any) =>
            app.log.warn({ err: e.message, user: oldMqttUser }, 'old mqtt user remove failed'));
          await removeDeviceAcl(oldMqttUser).catch((e: any) =>
            app.log.warn({ err: e.message, user: oldMqttUser }, 'old mqtt acl remove failed'));
        }
        await addMqttUser(mqttUser, mqttPass);
        await appendDeviceAcl(mqttUser, deviceId);
        await reloadMosquitto();
      } catch (e: any) {
        app.log.error({ err: e.message }, 'mosquitto provisioning failed');
        await client.query('rollback');
        return reply.code(500).send({ error: 'broker_provision_failed' });
      }

      await client.query('commit');

      return reply.send({
        device_id:   deviceId,
        broker_host: brokerHost,
        broker_port: brokerPort,
        mqtt_user:   mqttUser,
        mqtt_pass:   mqttPass,
        ca_cert:     caCertPem,
      });
    } catch (e: any) {
      await client.query('rollback').catch(() => {});
      app.log.error({ err: e.message }, 'redeem failed');
      return reply.code(500).send({ error: 'redeem_failed' });
    } finally {
      client.release();
    }
  });

  // ------------------- App: list devices -------------------
  // GET /v1/devices
  app.get('/v1/devices', { preHandler: app.requireUser }, async (req: any, reply) => {
    const r = await app.db.query(
      `select id, name, hardware_id, firmware_version, last_seen_at, created_at
         from devices where user_id=$1 order by created_at desc`,
      [req.user.sub],
    );
    return reply.send({ devices: r.rows });
  });

  // PATCH /v1/devices/:id  — rename
  app.patch('/v1/devices/:id', { preHandler: app.requireUser }, async (req: any, reply) => {
    const schema = z.object({ name: z.string().min(1).max(64) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });
    const r = await app.db.query(
      'update devices set name=$1 where id=$2 and user_id=$3 returning id, name',
      [parsed.data.name, req.params.id, req.user.sub],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    return reply.send(r.rows[0]);
  });

  // DELETE /v1/devices/:id  — unpair (also revokes MQTT user)
  app.delete('/v1/devices/:id', { preHandler: app.requireUser }, async (req: any, reply) => {
    const r = await app.db.query(
      'delete from devices where id=$1 and user_id=$2 returning mqtt_username',
      [req.params.id, req.user.sub],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'not_found' });
    const username = r.rows[0].mqtt_username;
    try {
      await removeMqttUser(username);
      await removeDeviceAcl(username);
      await reloadMosquitto();
    } catch (e: any) {
      app.log.warn({ err: e.message, username }, 'broker cleanup failed (DB row deleted)');
    }
    return reply.send({ ok: true });
  });
}
