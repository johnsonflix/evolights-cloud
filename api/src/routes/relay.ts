import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';

/**
 * Cloud command relay.
 *
 * The mobile app cannot reach a device behind a home firewall directly. It
 * sends commands to us; we publish them on `evolights/<device_id>/cmd`; the
 * device (which holds an outbound MQTT connection to us) executes locally
 * and publishes the response on `evolights/<device_id>/state`. We correlate
 * by `id` and complete the HTTP response.
 *
 * Pending requests live in-memory only — fine for a single instance. For
 * multi-instance deploys we'd promote this to a Redis pub/sub keyed channel.
 */

interface PendingReq {
  resolve: (resp: any) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
}
const pending = new Map<string, PendingReq>();

export async function registerRelayRoutes(app: FastifyInstance) {
  const ackTimeoutMs = Number(process.env.RELAY_ACK_TIMEOUT_MS ?? 5000);

  // Subscribe once to all device state topics; the device id is in the path.
  app.mqtt.subscribe('evolights/+/state', (err) => {
    if (err) app.log.error({ err: err.message }, 'mqtt subscribe failed');
  });
  app.mqtt.on('message', (topic, payload) => {
    if (!topic.endsWith('/state')) return;
    let msg: any;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    const id = msg?.id;
    if (typeof id !== 'string') return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(msg);
  });

  /**
   * POST /v1/devices/:id/relay
   * Body: { path: "/json/state", method: "GET"|"POST", body?: any }
   * Auth: user JWT; device must belong to the user.
   *
   * Publishes {id, path, method, body} to evolights/<device_id>/cmd, waits
   * up to RELAY_ACK_TIMEOUT_MS for the device to publish a matching reply
   * on evolights/<device_id>/state.
   */
  app.post('/v1/devices/:id/relay', { preHandler: app.requireUser }, async (req: any, reply) => {
    const schema = z.object({
      path:   z.string().startsWith('/').max(256),
      method: z.enum(['GET', 'POST', 'DELETE', 'PUT']).default('GET'),
      body:   z.any().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_payload' });

    const ownership = await app.db.query(
      'select id from devices where id=$1 and user_id=$2', [req.params.id, req.user.sub],
    );
    if (!ownership.rowCount) return reply.code(404).send({ error: 'device_not_found' });

    const id = crypto.randomBytes(8).toString('hex');
    const cmd = { id, ...parsed.data };

    const responsePromise = new Promise<any>((resolve, rejectInner) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectInner(new Error('device_timeout'));
      }, ackTimeoutMs);
      pending.set(id, { resolve, timer, deviceId: req.params.id });
    });

    app.mqtt.publish(`evolights/${req.params.id}/cmd`, JSON.stringify(cmd), { qos: 1 });

    try {
      const resp = await responsePromise;
      // Touch last_seen on every successful relay.
      app.db.query('update devices set last_seen_at=now() where id=$1', [req.params.id]).catch(() => {});
      return reply.code(resp.status ?? 200).send(resp.body ?? null);
    } catch (e: any) {
      if (e.message === 'device_timeout') return reply.code(504).send({ error: 'device_timeout' });
      return reply.code(502).send({ error: 'relay_failed', detail: e.message });
    }
  });

  // Quick health view for the operator: how many pending relays are we waiting on?
  app.get('/v1/relay/pending', async () => ({ pending: pending.size }));
}
