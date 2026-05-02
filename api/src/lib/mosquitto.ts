import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Mosquitto user/ACL provisioning by editing the password and ACL files
 * mounted into the broker container, then sending it SIGHUP to reload.
 *
 * This is the simplest way to wire dynamic per-device credentials into a
 * stock eclipse-mosquitto:2 image without bringing in a custom auth plugin.
 * Trade-off: edits are file-based and not transactional — if two pairings
 * race, one's write may overwrite the other's. We hold a Postgres advisory
 * lock around the operation to serialize.
 */

const MOSQ_DIR = process.env.MOSQUITTO_DIR ?? '/mosquitto-config';
const PASSWD   = path.join(MOSQ_DIR, 'passwd');
const ACL      = path.join(MOSQ_DIR, 'acl');
const MOSQ_CONTAINER = process.env.MOSQUITTO_CONTAINER ?? 'evolights-cloud-mosquitto-1';

export async function addMqttUser(username: string, password: string): Promise<void> {
  // mosquitto_passwd binary may not be on the api container; we shell out via docker exec
  // into the mosquitto container, which always has it.
  await exec('docker', [
    'exec', MOSQ_CONTAINER,
    'mosquitto_passwd', '-b', '/mosquitto/config/passwd', username, password,
  ]);
}

export async function removeMqttUser(username: string): Promise<void> {
  await exec('docker', [
    'exec', MOSQ_CONTAINER,
    'mosquitto_passwd', '-D', '/mosquitto/config/passwd', username,
  ]);
}

export async function appendDeviceAcl(username: string, deviceId: string): Promise<void> {
  // Idempotent: skip if a rule for this user already exists.
  const acl = await fs.readFile(ACL, 'utf8').catch(() => '');
  if (acl.includes(`\nuser ${username}\n`)) return;

  const block = `
user ${username}
topic write evolights/${deviceId}/state
topic write evolights/${deviceId}/log
topic read  evolights/${deviceId}/cmd
topic read  evolights/${deviceId}/ota
`;
  await fs.appendFile(ACL, block, 'utf8');
}

export async function removeDeviceAcl(username: string): Promise<void> {
  const acl = await fs.readFile(ACL, 'utf8').catch(() => '');
  // Remove the block from "user <name>" up to (not including) the next blank line / next user.
  const re = new RegExp(`\\nuser ${username}\\n(?:.*\\n)*?(?=\\nuser |$)`, 'g');
  await fs.writeFile(ACL, acl.replace(re, ''), 'utf8');
}

export async function reloadMosquitto(): Promise<void> {
  // SIGHUP reloads passwd + acl without dropping connections.
  await exec('docker', ['kill', '-s', 'HUP', MOSQ_CONTAINER]);
}

/** Generates a random alphanumeric password for a per-device MQTT user. */
export function generateMqttPassword(byteLen = 24): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = require('node:crypto').randomBytes(byteLen);
  let out = '';
  for (let i = 0; i < byteLen; i++) out += chars[bytes[i] % chars.length];
  return out;
}
