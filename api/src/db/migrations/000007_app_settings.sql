-- 000007_app_settings.sql
-- Runtime-mutable application settings. Operators can change these via the
-- admin UI without editing .env / restarting containers. Env vars become
-- first-boot defaults (consulted by getSetting() when no DB row exists for a
-- key); the DB is the source of truth at runtime.
--
-- Values are stored as jsonb so we can keep typed shapes (numbers, booleans,
-- arrays) without per-setting columns. The settings registry in
-- src/lib/settings.ts owns the typed schema; the DB is intentionally
-- schemaless to avoid a migration every time we add a knob.
--
-- updated_by is nullable because (a) the very first write may be the
-- bootstrap admin and (b) we want soft-delete of users to keep these rows
-- around (FK with on delete set null).
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  is_secret   boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references users(id) on delete set null
);

-- Newest-first sort for the admin UI's "recently changed" view; cheap on a
-- table that will only ever have ~30 rows but kept for symmetry with other
-- timestamped tables.
create index if not exists app_settings_updated_at_idx
  on app_settings(updated_at desc);
