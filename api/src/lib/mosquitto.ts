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
 * race, one's write may overwrite the other's. The CALLER is responsible
 * for serialising; in routes/devices.ts we hold a Postgres advisory xact
 * lock (`pg_advisory_xact_lock(hashtext('mosquitto-provision'))`) around
 * addMqttUser+appendDeviceAcl+reloadMosquitto so concurrent API replicas
 * don't clobber each other's edits.
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
  // Line-based parser. The previous regex approach had three problems:
  //   1. The username was interpolated unescaped into the pattern, so any
  //      regex metacharacter in the (DB-generated, but still: defence in
  //      depth) username would corrupt the match.
  //   2. The leading `\n` lookahead made the FIRST user block in the file
  //      unmatchable.
  //   3. fs.writeFile is not atomic; a crash mid-write left a truncated
  //      ACL file that mosquitto would then refuse to parse, taking the
  //      broker down on the next reload.
  //
  // Fix: walk the file by lines, drop the block starting at the matching
  // "user <name>" line and continuing until the next "user " or EOF, then
  // write the result to a sibling temp file and rename() over the target.
  // rename() is atomic on POSIX (and on Windows for same-volume targets),
  // so a crash leaves either the old or the new file fully intact.
  const acl = await fs.readFile(ACL, 'utf8').catch(() => '');
  if (!acl) return;

  const target = `user ${username}`;
  const lines = acl.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === target) {
      // Skip this block: this line and every following non-`user ` line.
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('user ')) {
        i++;
      }
      // Don't advance past a `user ...` line — it starts the next block.
      continue;
    }
    out.push(line);
    i++;
  }

  const tmp = ACL + '.tmp';
  await fs.writeFile(tmp, out.join('\n'), 'utf8');
  await fs.rename(tmp, ACL);
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
