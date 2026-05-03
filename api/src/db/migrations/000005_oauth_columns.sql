-- 000005_oauth_columns.sql
-- Sign in with Apple / Sign in with Google support.
--   apple_sub  : Apple's stable per-user identifier (sub claim from id_token)
--   google_sub : Google's stable per-user identifier (sub claim from id_token)
-- We allow password_hash to be null because users who sign up via OAuth never
-- pick a local password. They can later set one via the (future) "set
-- password" endpoint or always sign in via the same provider.
-- email_verified is set to true when the OAuth provider asserts the email is
-- verified (Apple's email_verified claim, Google's email_verified claim).
alter table users add column if not exists apple_sub  text;
alter table users add column if not exists google_sub text;

create unique index if not exists users_apple_sub_idx
  on users(apple_sub) where apple_sub is not null;
create unique index if not exists users_google_sub_idx
  on users(google_sub) where google_sub is not null;

alter table users alter column password_hash drop not null;

alter table users add column if not exists email_verified boolean not null default false;
