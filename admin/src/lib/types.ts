/**
 * Mirror of the API response shapes the admin UI consumes. Mirroring rather
 * than importing directly because the api package has no JS export surface
 * (it's a server, not a library); duplicating ~50 LOC of types is cheaper
 * than wiring up a shared package for one consumer.
 *
 * Keep these in sync with api/src/routes/*.ts.
 */

export interface MeResponse {
  id: string;
  email: string;
  created_at: string;
  email_verified: boolean;
  sub_status: string | null;
  current_period_end: string | null;
}

export interface AdminStats {
  users_count: number;
  devices_count: number;
  active_subscriptions: number;
  mrr_cents: number | null;
  last_24h_signups: number;
  last_24h_pairings: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  is_admin: boolean;
  email_verified: boolean;
  created_at: string;
  deleted_at: string | null;
  sub_status: string | null;
  current_period_end: string | null;
}

export interface AdminUsersResponse {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminUserDetailUser {
  id: string;
  email: string;
  is_admin: boolean;
  email_verified: boolean;
  has_apple: boolean;
  has_google: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  tokens_valid_after: string;
}

export interface AdminUserDetailDevice {
  id: string;
  name: string;
  hardware_id: string;
  firmware_version: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface AdminUserSubscription {
  stripe_customer_id: string;
  stripe_sub_id: string | null;
  status: string;
  current_period_end: string | null;
  updated_at: string;
}

export interface AdminUserDetail {
  user: AdminUserDetailUser;
  devices: AdminUserDetailDevice[];
  subscription: AdminUserSubscription | null;
}

export interface AdminDeviceRow {
  id: string;
  name: string;
  hardware_id: string;
  firmware_version: string | null;
  last_seen_at: string | null;
  created_at: string;
  user_id: string;
  user_email: string;
}

export interface AdminDevicesResponse {
  devices: AdminDeviceRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface FirmwareRow {
  id: string;
  version: string;
  board: string;
  channel: 'stable' | 'beta' | 'dev';
  url: string;
  signature: string;
  released_at: string;
}

export interface FirmwareListResponse {
  firmware: FirmwareRow[];
}

/**
 * Runtime settings response shape.
 *
 * Mirrors api/src/lib/settings.ts SettingView. Each entry is one row in
 * the registry; for secret keys the `value` field is omitted and the UI
 * relies on `is_secret_set` to decide whether to render a "configured"
 * placeholder.
 */
export type SettingGroup =
  | 'public'
  | 'branding'
  | 'email'
  | 'oauth'
  | 'stripe'
  | 'behavior'
  | 'security';

export type SettingType = 'string' | 'number' | 'boolean' | 'enum' | 'text' | 'csv';

export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  hint: string | null;
  type: SettingType;
  enum_values: string[] | null;
  is_secret: boolean;
  is_secret_set: boolean;
  /** Present (and possibly null) for non-secret settings; omitted for secrets. */
  value?: unknown;
  has_db_override: boolean;
  needs_restart: boolean;
  updated_at: string | null;
  updated_by_email: string | null;
}

export interface AdminSettingsResponse {
  settings: SettingView[];
  needs_restart: boolean;
}

export interface StripeProduct {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  created: number;
}

export interface StripePrice {
  id: string;
  product: string;
  currency: string;
  unit_amount: number | null;
  recurring: { interval: string; interval_count: number } | null;
  active: boolean;
  created: number;
}

export interface StripeCoupon {
  id: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: 'forever' | 'once' | 'repeating';
  duration_in_months: number | null;
  valid: boolean;
  created: number;
}
