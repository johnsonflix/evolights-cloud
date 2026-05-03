/**
 * admin-promote.ts — bootstrap admin access from the CLI.
 *
 * Usage:
 *   npm run admin:promote -- you@example.com
 *
 * Connects to DATABASE_URL, sets users.is_admin = true on the row matching
 * the given email. Refuses to operate on soft-deleted rows. Exits non-zero
 * if the email isn't found so calling scripts can fail loudly.
 *
 * This exists because /v1/admin/users/:id/promote requires an existing admin
 * to act, and the very first admin has no one to promote them. Operators
 * run this once at deploy time after creating their account through the
 * normal /v1/auth/register flow.
 */

import pg from 'pg';

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    console.error('usage: npm run admin:promote -- <email>');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = await pool.query<{ id: string; is_admin: boolean }>(
      `update users
          set is_admin = true,
              updated_at = now()
        where email = $1 and deleted_at is null
        returning id, is_admin`,
      [email],
    );
    if (!r.rowCount) {
      console.error(`no live user with email "${email}"`);
      process.exit(1);
    }
    console.log(`promoted ${email} (id=${r.rows[0].id}) is_admin=${r.rows[0].is_admin}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
