/**
 * Runtime-mutable settings registry.
 *
 * Why this exists
 *  Historically every operator-tunable knob was a process.env.* read, which
 *  meant changing the public MQTT hostname or rotating an SMTP password
 *  required editing .env on the host and bouncing the api container. That's
 *  a tractable workflow for a one-person ops team but it scales badly and
 *  there's no audit trail (who changed it, when, from what).
 *
 *  This module turns each of those knobs into a (key, jsonb) row in
 *  app_settings, with the env var preserved as a first-boot default. The
 *  fall-through order on read is:
 *      DB row    >    process.env.<envKey>    >    caller-supplied fallback
 *
 *  Writes go through setSetting(), which validates the key against the
 *  registry, persists to DB, and invalidates the in-process cache. Other
 *  api replicas pick up the change on their next cache miss (within
 *  CACHE_TTL_MS).
 *
 * What it deliberately does NOT cover
 *  Settings that are GENUINELY secret (JWT_SECRET, DATABASE_URL,
 *  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, MQTT_API_PASSWORD,
 *  POSTGRES_PASSWORD, OTA_SIGNING_KEY_PATH) stay env-only:
 *    - they belong in container/host secret stores, not app DB
 *    - rotating them via a web UI risks bricking the running process
 *      (e.g. a typo'd JWT_SECRET invalidates every active session)
 *    - they're set once at deploy time, not tweaked
 *  EMAIL secrets (SMTP_PASS, GRAPH_CLIENT_SECRET) are an explicit exception:
 *  operators DO rotate these regularly, the email service can be reloaded
 *  on the next send without touching the process, and a misconfigured email
 *  provider only breaks transactional email (forgot-password) -- not auth,
 *  not pairing, not relay. Worth the trade-off; flagged isSecret so they're
 *  redacted in API responses.
 */

import type { Pool } from 'pg';

export type SettingGroup =
  | 'public'
  | 'branding'
  | 'email'
  | 'oauth'
  | 'stripe'
  | 'behavior'
  | 'security';

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'text' | 'csv';

export interface SettingDef {
  /** Dot-notation key, e.g. 'mqtt.public_host'. Stable; treat as an API. */
  key: string;
  /** Legacy env var consulted as fallback when no DB row exists. */
  envKey?: string;
  /** When true, value is omitted from GET responses; only is_secret_set is exposed. */
  isSecret?: boolean;
  /** Logical group for the admin UI tab grouping. */
  group: SettingGroup;
  /** Short human label shown next to the input in the admin UI. */
  label: string;
  /** Optional help text rendered under the input. */
  hint?: string;
  /** Render hint for the admin UI; the API layer enforces the type on PATCH. */
  type: SettingType;
  /** Allowed values when type === 'enum'. */
  enumValues?: string[];
  /** Optional transformer for the raw env-var string into the runtime type. */
  parseEnv?: (s: string) => unknown;
  /**
   * Some settings don't take effect at runtime (e.g. CORS is bound at plugin
   * registration time). Mark them so the admin UI can warn the operator
   * that a container restart is required before the change is observed.
   */
  needsRestart?: boolean;
}

/**
 * Registry of every UI-configurable setting. Add new settings here; the
 * admin UI auto-renders the field, the GET/PATCH endpoints auto-accept it.
 *
 * Keys MUST be stable. Renaming a key is a breaking change because any
 * existing app_settings row would be orphaned; use a new key + a manual
 * data migration if you really must rename.
 */
export const SETTINGS: SettingDef[] = [
  // --- public endpoints ---
  {
    key: 'mqtt.public_host',
    envKey: 'MQTT_PUBLIC_HOST',
    group: 'public',
    label: 'MQTT broker hostname',
    hint: 'DNS your devices connect to (e.g. mqtt.evolights.io). Affects new pairings only; already-paired devices keep their cached value until they re-pair.',
    type: 'string',
  },
  {
    key: 'mqtt.public_port',
    envKey: 'MQTT_PUBLIC_PORT',
    group: 'public',
    label: 'MQTT broker port',
    hint: 'Typically 8883 (TLS).',
    type: 'number',
    parseEnv: (s) => Number(s),
  },
  {
    key: 'mqtt.ca_cert_pem',
    envKey: 'MQTT_CA_PEM_PATH',
    group: 'public',
    label: 'MQTT broker CA certificate (PEM)',
    hint: 'Devices use this to validate the broker TLS certificate. The env-var form is a path; the UI accepts the PEM contents directly.',
    type: 'text',
    parseEnv: (path) => {
      // Lazily read the file on first access. Mirrors the original
      // routes/devices.ts behaviour (which also did a sync read at boot).
      // We return an empty string on failure rather than throwing so a
      // missing cert path doesn't break boot.
      try {
        // require is fine here even in ESM because tsconfig targets ES2022
        // with module=ES2022 (Node ESM) -- we reach for createRequire.
        // Simpler: inline read with fs.readFileSync via dynamic import is
        // overkill for a one-time boot read; use a sync require.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('node:fs') as typeof import('node:fs');
        return fs.readFileSync(path, 'utf8');
      } catch {
        return '';
      }
    },
  },
  {
    key: 'api.public_url',
    envKey: 'PUBLIC_API_URL',
    group: 'public',
    label: 'Public API URL',
    hint: 'e.g. https://api.evolights.io — used in pairing responses returned to the mobile app.',
    type: 'string',
  },
  {
    key: 'web.public_url',
    envKey: 'PUBLIC_WEB_URL',
    group: 'public',
    label: 'Public web URL',
    hint: 'Used in password-reset email links (e.g. https://app.evolights.io).',
    type: 'string',
  },

  // --- branding ---
  {
    key: 'brand.name',
    envKey: 'BRAND_NAME',
    group: 'branding',
    label: 'Product brand name',
    hint: 'Shown in transactional emails and the admin header. Default: EvoLights.',
    type: 'string',
  },

  // --- email ---
  {
    key: 'email.provider',
    envKey: 'EMAIL_PROVIDER',
    group: 'email',
    label: 'Email provider',
    hint: 'Empty disables transactional email entirely (forgot-password will 503).',
    type: 'enum',
    enumValues: ['', 'smtp', 'graph'],
  },
  {
    key: 'email.from',
    envKey: 'EMAIL_FROM',
    group: 'email',
    label: 'From address',
    hint: 'e.g. "EvoLights <noreply@evolights.io>"',
    type: 'string',
  },
  { key: 'email.smtp.host',   envKey: 'SMTP_HOST',   group: 'email', label: 'SMTP host',   type: 'string' },
  { key: 'email.smtp.port',   envKey: 'SMTP_PORT',   group: 'email', label: 'SMTP port',   type: 'number', parseEnv: (s) => Number(s) },
  {
    key: 'email.smtp.secure',
    envKey: 'SMTP_SECURE',
    group: 'email',
    label: 'SMTP TLS',
    hint: 'true for port 465 (TLS), false for 587 (STARTTLS).',
    type: 'boolean',
    parseEnv: (s) => s.toLowerCase() === 'true',
  },
  { key: 'email.smtp.user', envKey: 'SMTP_USER', group: 'email', label: 'SMTP user', type: 'string' },
  {
    key: 'email.smtp.pass',
    envKey: 'SMTP_PASS',
    group: 'email',
    label: 'SMTP password',
    isSecret: true,
    type: 'string',
  },
  { key: 'email.graph.tenant_id', envKey: 'GRAPH_TENANT_ID', group: 'email', label: 'Microsoft Graph tenant ID', type: 'string' },
  { key: 'email.graph.client_id', envKey: 'GRAPH_CLIENT_ID', group: 'email', label: 'Graph client ID',         type: 'string' },
  {
    key: 'email.graph.client_secret',
    envKey: 'GRAPH_CLIENT_SECRET',
    group: 'email',
    label: 'Graph client secret',
    isSecret: true,
    type: 'string',
  },
  { key: 'email.graph.sender_upn', envKey: 'GRAPH_SENDER_UPN', group: 'email', label: 'Graph sender mailbox UPN', type: 'string' },

  // --- oauth ---
  { key: 'oauth.apple.client_id',          envKey: 'APPLE_CLIENT_ID',          group: 'oauth', label: 'Apple Services ID',     type: 'string' },
  { key: 'oauth.google.ios_client_id',     envKey: 'GOOGLE_CLIENT_ID_IOS',     group: 'oauth', label: 'Google iOS client ID',     type: 'string' },
  { key: 'oauth.google.android_client_id', envKey: 'GOOGLE_CLIENT_ID_ANDROID', group: 'oauth', label: 'Google Android client ID', type: 'string' },
  { key: 'oauth.google.web_client_id',     envKey: 'GOOGLE_CLIENT_ID_WEB',     group: 'oauth', label: 'Google web client ID',     type: 'string' },

  // --- stripe ---
  { key: 'stripe.price_id_monthly',     envKey: 'STRIPE_PRICE_ID_MONTHLY',     group: 'stripe', label: 'Default monthly price ID', type: 'string' },
  {
    key: 'stripe.price_amount_cents',
    envKey: 'STRIPE_PRICE_AMOUNT_CENTS',
    group: 'stripe',
    label: 'Monthly price (cents) for MRR estimate',
    hint: 'Used by /v1/admin/stats to compute mrr_cents = active_subs * this. Leave empty to return null.',
    type: 'number',
    parseEnv: (s) => Number(s),
  },

  // --- behavior ---
  {
    key: 'behavior.pairing_code_ttl_seconds',
    envKey: 'PAIRING_CODE_TTL_SECONDS',
    group: 'behavior',
    label: 'Pairing code TTL (seconds)',
    hint: 'How long a /v1/pairing/codes code remains redeemable. Default 300 (5 min).',
    type: 'number',
    parseEnv: (s) => Number(s),
  },
  {
    key: 'behavior.relay_timeout_ms',
    envKey: 'RELAY_ACK_TIMEOUT_MS',
    group: 'behavior',
    label: 'Relay timeout (ms)',
    hint: 'How long the cloud waits for a device reply before returning 504. Default 5000.',
    type: 'number',
    parseEnv: (s) => Number(s),
  },

  // --- security ---
  {
    key: 'security.cors_origins',
    envKey: 'CORS_ORIGIN',
    group: 'security',
    label: 'Allowed CORS origins',
    hint:
      'Comma-separated list of origins for browser clients. Empty list = deny all (mobile apps + Stripe webhook still work). ' +
      'Changes here require a container restart -- the CORS plugin reads at registration time.',
    type: 'csv',
    needsRestart: true,
    parseEnv: (s) => s.split(',').map((x) => x.trim()).filter(Boolean),
  },
];

// --- in-process cache --------------------------------------------------------
// Bounded TTL so other replicas pick up writes within ~CACHE_TTL_MS even if
// they don't see the invalidation (we deliberately don't wire pg LISTEN/NOTIFY
// for this -- one minute of staleness on a CORS or branding change is fine).

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; expires: number }>();

/** Drop one key (or the whole table) from the in-process cache. */
export function invalidateSettingsCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}

/**
 * Fetch a setting's runtime value.
 *
 * Resolution order:
 *   1. cache hit (within CACHE_TTL_MS)
 *   2. DB row in app_settings
 *   3. process.env[def.envKey] (parsed via def.parseEnv if present)
 *   4. caller-supplied fallback
 *   5. null
 *
 * The fallback parameter is a code-side default for callers that want to
 * keep behaviour identical to the old `process.env.X ?? "default"` pattern.
 * It does NOT get persisted to the DB; the registry's envKey is the source
 * of operator-visible defaults.
 */
export async function getSetting<T = unknown>(
  db: Pool,
  key: string,
  fallback?: T,
): Promise<T | null> {
  const def = SETTINGS.find((s) => s.key === key);

  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    return cached.value as T;
  }

  const r = await db.query<{ value: unknown }>(
    'select value from app_settings where key = $1',
    [key],
  );

  let value: unknown = null;
  if (r.rowCount) {
    value = r.rows[0].value;
  } else if (def?.envKey && process.env[def.envKey] !== undefined) {
    const raw = process.env[def.envKey]!;
    value = def.parseEnv ? def.parseEnv(raw) : raw;
  } else if (fallback !== undefined) {
    value = fallback as unknown;
  }

  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value as T | null;
}

/**
 * Persist a setting and invalidate its cache entry.
 *
 * Throws if `key` is not in the registry -- prevents typoed keys from
 * silently sitting in the DB forever. The admin PATCH endpoint catches and
 * 400s on this.
 */
export async function setSetting(
  db: Pool,
  key: string,
  value: unknown,
  userId: string,
): Promise<void> {
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) throw new Error(`unknown_setting:${key}`);
  await db.query(
    `insert into app_settings (key, value, is_secret, updated_by)
     values ($1, $2::jsonb, $3, $4)
     on conflict (key) do update
       set value      = excluded.value,
           is_secret  = excluded.is_secret,
           updated_at = now(),
           updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), !!def.isSecret, userId],
  );
  invalidateSettingsCache(key);
}

/**
 * Delete a setting -- restores fall-through to the env var (or null).
 *
 * Used by the admin UI when an operator wants to revert a knob to its
 * env-driven default rather than overriding it.
 */
export async function clearSetting(db: Pool, key: string): Promise<void> {
  const def = SETTINGS.find((s) => s.key === key);
  if (!def) throw new Error(`unknown_setting:${key}`);
  await db.query('delete from app_settings where key = $1', [key]);
  invalidateSettingsCache(key);
}

/**
 * Bulk-fetch every registered setting with metadata for the admin UI.
 *
 * Returns one entry per registry key, even those that have no DB row and no
 * env value (value: null). For secret settings, value is omitted; the UI
 * gets is_secret_set so it can render "*** configured ***" placeholders.
 */
export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  hint: string | null;
  type: SettingType;
  enum_values: string[] | null;
  is_secret: boolean;
  /** True when the value is configured somewhere (DB row OR env var). */
  is_secret_set: boolean;
  /** Present (and possibly null) for non-secret settings; omitted for secrets. */
  value?: unknown;
  /** True when the setting is in app_settings (vs. only inheriting from env). */
  has_db_override: boolean;
  /** True if the setting requires a container restart to take effect. */
  needs_restart: boolean;
  updated_at: string | null;
  updated_by_email: string | null;
}

export async function listSettings(db: Pool): Promise<SettingView[]> {
  // One query joins the DB rows with the user email so the UI can show
  // "last changed by alice@..." next to each row.
  const r = await db.query<{
    key: string;
    value: unknown;
    updated_at: string;
    updated_by_email: string | null;
  }>(`
    select s.key, s.value, s.updated_at, u.email as updated_by_email
      from app_settings s
      left join users u on u.id = s.updated_by
  `);
  const dbRows = new Map(r.rows.map((row) => [row.key, row]));

  return SETTINGS.map((def) => {
    const row = dbRows.get(def.key);
    const envRaw = def.envKey ? process.env[def.envKey] : undefined;

    let resolved: unknown = null;
    if (row) {
      resolved = row.value;
    } else if (envRaw !== undefined) {
      resolved = def.parseEnv ? def.parseEnv(envRaw) : envRaw;
    }

    const isSet = row !== undefined ||
                  (envRaw !== undefined && envRaw !== '');

    const view: SettingView = {
      key: def.key,
      group: def.group,
      label: def.label,
      hint: def.hint ?? null,
      type: def.type,
      enum_values: def.enumValues ?? null,
      is_secret: !!def.isSecret,
      is_secret_set: isSet,
      has_db_override: row !== undefined,
      needs_restart: !!def.needsRestart,
      updated_at: row?.updated_at ?? null,
      updated_by_email: row?.updated_by_email ?? null,
    };
    if (!def.isSecret) {
      view.value = resolved;
    }
    return view;
  });
}

/**
 * Validate a value against a setting's declared type. Returns either the
 * coerced value to persist, or an Error explaining why it doesn't fit.
 *
 * The admin PATCH endpoint runs this on every {key, value} pair before
 * touching the DB; failure 400s with the offending key.
 */
export function validateSettingValue(
  def: SettingDef,
  raw: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  // null is universally accepted -- it means "clear this setting / restore
  // the env-driven default". The PATCH handler maps it to a DELETE.
  if (raw === null) return { ok: true, value: null };

  switch (def.type) {
    case 'string':
    case 'text':
      if (typeof raw !== 'string') return { ok: false, error: 'expected_string' };
      return { ok: true, value: raw };
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return { ok: false, error: 'expected_finite_number' };
      }
      return { ok: true, value: raw };
    case 'boolean':
      if (typeof raw !== 'boolean') return { ok: false, error: 'expected_boolean' };
      return { ok: true, value: raw };
    case 'enum':
      if (typeof raw !== 'string') return { ok: false, error: 'expected_string_enum' };
      if (def.enumValues && !def.enumValues.includes(raw)) {
        return { ok: false, error: `expected_one_of:${def.enumValues.join('|')}` };
      }
      return { ok: true, value: raw };
    case 'csv':
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
        return { ok: false, error: 'expected_string_array' };
      }
      return { ok: true, value: raw };
  }
}
