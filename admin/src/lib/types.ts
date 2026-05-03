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

export interface AdminSettings {
  node_env: string;
  app_version: string;
  public_web_url: string | null;
  public_api_url: string | null;
  cors_origins: string[];
  stripe_configured: boolean;
  stripe_price_amount_cents: number | null;
  email: {
    provider: string | null;
    from: string | null;
    smtp_configured: boolean;
    graph_configured: boolean;
  };
  oauth: {
    apple_configured: boolean;
    google_configured: boolean;
    google_audiences: string[];
  };
  mqtt: {
    public_host: string | null;
    public_port: number;
  };
  ota: {
    signing_key_configured: boolean;
  };
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
