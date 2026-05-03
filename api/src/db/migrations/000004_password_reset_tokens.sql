-- 000004_password_reset_tokens.sql
-- Password reset flow. Tokens are 32 hex chars (16 random bytes), single-use,
-- claimed atomically via conditional UPDATE in routes/auth.ts. We persist the
-- raw token because (a) the token is single-use and short-lived (30 min), so
-- at-rest exposure is bounded, and (b) keeping it raw lets us look up by
-- token directly without an extra hash step. If we ever raise TTL we should
-- switch to storing only sha256(token).
create table if not exists password_reset_tokens (
  token       text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists password_reset_tokens_user_idx on password_reset_tokens(user_id);
