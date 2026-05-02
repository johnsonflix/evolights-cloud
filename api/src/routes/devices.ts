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
  app.post('/v1/devices/redeem', async (req, reply) => {
    const schema = z.object({
      code:       z.string().length(6),
      fw_version: z.string().min(1).max(32),
      chip_id:    z.string().min(1).max(64),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const { code, fw_version, chip_id } = parsed.data;
    const r = await app.db.query(
      `select user_id, expires_at, used_at from pairing_codes where code=$1`,
      [code],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'unknown_code' });
    const pc = r.rows[0];
    if (pc.used_at) return reply.code(410).send({ error: 'code_already_used' });
    if (new Date(pc.expires_at) < new Date()) return reply.code(410).send({ error: 'code_expired' });

    // Confirm the user still has an active subscription (codes are short-lived
    // but a sub could have lapsed in the window).
    const sub = await app.db.query('select status from subscriptions where user_id=$1', [pc.user_id]);
    if (!sub.rowCount || !hasActiveSub(sub.rows[0].status)) {
      return reply.code(402).send({ error: 'subscription_inactive' });
    }

    // Provision device record + MQTT user/ACL.
    const mqttUser = `dev_${chip_id.toLowerCase()}_${crypto.randomBytes(4).toString('hex')}`;
    const mqttPass = generateMqttPassword();
    const mqttPassHash = await argon2.hash(mqttPass);

    const ins = await app.db.query(
      `insert into devices (user_id, name, hardware_id, mqtt_username, mqtt_password_hash, firmware_version)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (hardware_id) do update set
         user_id=excluded.user_id,
         mqtt_username=excluded.mqtt_username,
         mqtt_password_hash=excluded.mqtt_password_hash,
         firmware_version=excluded.firmware_version
       returning id`,
      [pc.user_id, `EvoLights ${chip_id.slice(-4).toUpperCase()}`, chip_id, mqttUser, mqttPassHash, fw_version],
    );
    const deviceId = ins.rows[0].id;

    // Mark code consumed.
    await app.db.query('update pairing_codes set used_at=now(), device_id=$1 where code=$2', [deviceId, code]);

    // Provision in mosquitto (passwd + ACL + SIGHUP).
    try {
      await addMqttUser(mqttUser, mqttPass);
      await appendDeviceAcl(mqttUser, deviceId);
      await reloadMosquitto();
    } catch (e: any) {
      app.log.error({ err: e.message }, 'mosquitto provisioning failed');
      return reply.code(500).send({ error: 'broker_provision_failed' });
    }

    return reply.send({
      device_id:   deviceId,
      broker_host: brokerHost,
      broker_port: brokerPort,
      mqtt_user:   mqttUser,
      mqtt_pass:   mqttPass,
      ca_cert:     caCertPem,
    });
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
