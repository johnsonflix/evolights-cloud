-- 000003_users_is_admin.sql
-- Administrative role. Bootstrap by manually flipping is_admin=true on a user row
-- in the DB. The OTA publish endpoint requires this. See routes/ota.ts.

alter table users
  add column if not exists is_admin boolean not null default false;
