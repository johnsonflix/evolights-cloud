-- 000002_tokens_valid_after.sql
-- JWT revocation support. We compare token's `iat` (issued-at, seconds since epoch)
-- against this timestamp on every request. To revoke all of a user's tokens
-- (e.g. on password change or "log out everywhere"), bump this column to now().

alter table users
  add column if not exists tokens_valid_after timestamptz not null default '1970-01-01T00:00:00Z';
