import type { FastifyInstance } from 'fastify';
import mqtt, { type MqttClient } from 'mqtt';

declare module 'fastify' {
  interface FastifyInstance {
    mqtt: MqttClient;
  }
}

export async function connectMqtt(app: FastifyInstance) {
  const url = process.env.MQTT_URL;
  if (!url) throw new Error('MQTT_URL is required');

  const client = mqtt.connect(url, {
    username: process.env.MQTT_API_USERNAME,
    password: process.env.MQTT_API_PASSWORD,
    reconnectPeriod: 2000,
    clientId: `evolights-api-${process.pid}-${Date.now()}`,
  });

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: Error) => {
      client.removeListener('connect', onOk);
      reject(err);
    };
    const onOk = () => {
      client.removeListener('error', onErr);
      resolve();
    };
    client.once('connect', onOk);
    client.once('error', onErr);
  });

  app.decorate('mqtt', client);
  app.log.info('mqtt connected');

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  });
}
