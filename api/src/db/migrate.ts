import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import type pg from 'pg';

/**
 * Tiny SQL migration runner.
 *
 * Reads `.sql` files from `src/db/migrations/` (lex-sorted) and applies any
 * that are not yet recorded in the `schema_migrations` table. Each migration
 * runs inside a single transaction so a partially-failed migration does not
 * leave the schema half-applied.
 *
 * We record applied migrations by filename. The legacy `schema.sql` mounted
 * into postgres-entrypoint may have already created tables — that's why
 * 000001_initial.sql uses `if not exists` everywhere; the runner will record
 * it as applied without erroring.
 *
 * (We considered node-pg-migrate, but its programmatic API expects JS
 * migrations by default; for an in-house Fastify boot path, ~50 LoC of plain
 * SQL replay is easier to audit.)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(db: pg.Pool, log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  await db.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const all = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRes = await db.query<{ filename: string }>('select filename from schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.filename));

  let count = 0;
  for (const filename of all) {
    if (applied.has(filename)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [filename]);
      await client.query('commit');
      log.info({ filename }, 'migration applied');
      count++;
    } catch (e) {
      await client.query('rollback').catch(() => {});
      log.error({ filename, err: (e as Error).message }, 'migration failed');
      throw e;
    } finally {
      client.release();
    }
  }
  log.info({ applied: count, total: all.length }, 'migrations complete');
}
