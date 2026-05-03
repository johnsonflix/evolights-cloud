import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';

/**
 * OTA delivery.
 *
 * Manifests we publish to evolights/<device_id>/ota look like:
 *   {
 *     "version": "0.1.0+ev3",
 *     "url":     "https://artifacts.evolights.io/fw/0.1.0+ev3/esp32dev_evolights.bin",
 *     "sha256":  "<hex>",
 *     "sig":     "<base64 ed25519 sig over `version|url|sha256`>",
 *     "min_fw":  "0.1.0"   // optional, refuse to flash if device older
 *   }
 *
 * The firmware verifies the signature against the Ed25519 public key compiled
 * into it (see firmware/wled00/wled_cloud_auth.cpp -> EvoLights::OTA pubkey).
 *
 * Generate the keypair once with:
 *   openssl genpkey -algorithm ed25519 -out ota-signing.key
 *   openssl pkey   -in ota-signing.key -pubout -out ota-signing.pub
 * Then base64 the raw 32-byte public key for embedding in firmware (see
 * tools/extract-ota-pubkey.sh in this repo).
 */

let signingKey: crypto.KeyObject | null = null;
async function loadSigningKey(): Promise<crypto.KeyObject> {
  if (signingKey) return signingKey;
  const p = process.env.OTA_SIGNING_KEY_PATH;
  if (!p) throw new Error('OTA_SIGNING_KEY_PATH not set');
  const pem = await fs.readFile(p);
  signingKey = crypto.createPrivateKey(pem);
  return signingKey;
}

function signManifest(version: string, url: string, sha256: string): string {
  if (!signingKey) throw new Error('signing key not loaded');
  const msg = Buffer.from(`${version}|${url}|${sha256}`);
  return crypto.sign(null, msg, signingKey).toString('base64');
}

export async function registerOtaRoutes(app: FastifyInstance) {
  // Eagerly try to load signing key on boot so we fail fast if it's missing.
  try { await loadSigningKey(); app.log.info('ota signing key loaded'); }
  catch (e: any) { app.log.warn({ err: e.message }, 'ota signing key not loaded; OTA endpoints will return 503'); }

  // POST /v1/ota/firmwares  (admin only)
  //
  // Body: { version, board, channel, url, sha256 }
  // Stores a signed manifest; later, /v1/ota/check fetches the latest matching channel.
  //
  // Auth model: standard user JWT + users.is_admin must be true. An operator
  // bootstraps admin access by manually flipping the column on a user row in
  // the DB. This is intentionally minimal (no self-promote endpoint).
  //
  // TODO: split signing from registration. Today, possession of an admin JWT
  // is sufficient to publish a firmware row that the cloud will then sign with
  // the OTA private key — so a single compromised admin password lets an
  // attacker push malware to every paired device. The fix is to require an
  // OFFLINE Ed25519 signature on `version|url|sha256` in the request body
  // (signed on a hardware token / HSM offline by a release engineer); this
  // endpoint then verifies that signature against a registered release-engineer
  // public key BEFORE countersigning for distribution. That defends against
  // compromised admin credentials by making the cloud-side key only a
  // distribution co-signer rather than the primary trust root.
  app.post('/v1/ota/firmwares', { preHandler: [app.requireUser, app.requireAdmin] }, async (req, reply) => {
    if (!signingKey) return reply.code(503).send({ error: 'signing_unavailable' });
    const schema = z.object({
      version: z.string().min(1).max(32),
      board:   z.string().min(1).max(32),
      channel: z.enum(['stable', 'beta', 'dev']).default('stable'),
      url:     z.string().url().max(512),
      sha256:  z.string().regex(/^[0-9a-f]{64}$/),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const sig = signManifest(parsed.data.version, parsed.data.url, parsed.data.sha256);
    const r = await app.db.query(
      `insert into firmware_versions (version, board, channel, url, signature)
       values ($1, $2, $3, $4, $5)
       on conflict (version, board, channel) do update set url=excluded.url, signature=excluded.signature
       returning id, released_at`,
      [parsed.data.version, parsed.data.board, parsed.data.channel, parsed.data.url, sig],
    );
    return reply.send({ id: r.rows[0].id, released_at: r.rows[0].released_at, signature: sig });
  });

  // GET /v1/ota/check?board=esp32dev_evolights&channel=stable&current=0.1.0
  // Used by the firmware (over the cloud relay) on boot to discover updates.
  app.get('/v1/ota/check', async (req, reply) => {
    const schema = z.object({
      board:   z.string().min(1).max(32),
      channel: z.enum(['stable', 'beta', 'dev']).default('stable'),
      current: z.string().min(1).max(32).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const r = await app.db.query(
      `select version, url, signature
         from firmware_versions
        where board=$1 and channel=$2
        order by released_at desc
        limit 1`,
      [parsed.data.board, parsed.data.channel],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'no_firmware' });
    const fw = r.rows[0];
    if (parsed.data.current && parsed.data.current === fw.version) {
      return reply.code(204).send();
    }
    // We re-derive sha256 client-side after download. Manifest signs over
    // version|url|sha256 — sha256 is stored alongside.
    return reply.send({
      version: fw.version,
      url:     fw.url,
      sig:     fw.signature,
    });
  });

  // POST /v1/devices/:id/ota/push
  // App-initiated: tell a specific device to fetch the latest firmware.
  // We just publish the manifest on the device's /ota topic; the device handles
  // download + verify + flash.
  app.post('/v1/devices/:id/ota/push', { preHandler: app.requireUser }, async (req: any, reply) => {
    const ownership = await app.db.query(
      'select id from devices where id=$1 and user_id=$2', [req.params.id, req.user.sub],
    );
    if (!ownership.rowCount) return reply.code(404).send({ error: 'device_not_found' });

    const board = (req.body as any)?.board ?? 'esp32dev_evolights';
    const channel = (req.body as any)?.channel ?? 'stable';
    const r = await app.db.query(
      `select version, url, signature from firmware_versions
        where board=$1 and channel=$2 order by released_at desc limit 1`,
      [board, channel],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'no_firmware' });
    const fw = r.rows[0];

    app.mqtt.publish(`evolights/${req.params.id}/ota`, JSON.stringify({
      version: fw.version,
      url:     fw.url,
      sig:     fw.signature,
    }), { qos: 1, retain: false });

    return reply.send({ ok: true, pushed: fw.version });
  });
}
