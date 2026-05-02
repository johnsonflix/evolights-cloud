-- EvoLights cloud schema (initial).
-- Loaded by postgres on first container start (mounted into /docker-entrypoint-initdb.d).

create extension if not exists "pgcrypto";

create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  password_hash   text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists subscriptions (
  user_id              uuid primary key references users(id) on delete cascade,
  stripe_customer_id   text not null unique,
  stripe_sub_id        text unique,
  status               text not null,            -- active | trialing | past_due | canceled | incomplete
  current_period_end   timestamptz,
  updated_at           timestamptz not null default now()
);

create table if not exists devices (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users(id) on delete cascade,
  name                 text not null,
  hardware_id          text not null unique,     -- ESP32 chip id, e.g. mac
  mqtt_username        text not null unique,
  mqtt_password_hash   text not null,
  firmware_version     text,
  last_seen_at         timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists devices_user_idx on devices(user_id);

create table if not exists pairing_codes (
  code        text primary key,                  -- short, ~6 char base32
  user_id     uuid not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  device_id   uuid references devices(id)
);

create index if not exists pairing_codes_user_idx on pairing_codes(user_id);

create table if not exists firmware_versions (
  id              uuid primary key default gen_random_uuid(),
  version         text not null,                 -- e.g. "0.1.0+ev3"
  board           text not null,                 -- esp32dev | esp32-s3 | etc.
  channel         text not null default 'stable',-- stable | beta | dev
  url             text not null,                 -- signed download URL
  signature       text not null,                 -- ed25519 signature, base64
  released_at     timestamptz not null default now(),
  unique (version, board, channel)
);
