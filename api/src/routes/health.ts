import type { FastifyInstance } from 'fastify';

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'evolights-cloud-api',
    version: process.env.APP_VERSION ?? 'dev',
    uptime_s: Math.floor(process.uptime()),
  }));

  app.get('/health/ready', async () => {
    const dbOk = await app.db.query('select 1').then(() => true).catch(() => false);
    const mqttOk = app.mqtt.connected;
    const ready = dbOk && mqttOk;
    return {
      ready,
      db: dbOk,
      mqtt: mqttOk,
    };
  });
}
