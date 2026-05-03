import { apiFetch } from '@/lib/api';
import type { AdminSettings } from '@/lib/types';

export const dynamic = 'force-dynamic';

function YesNo({ on, yes = 'configured', no = 'unconfigured' }: { on: boolean; yes?: string; no?: string }) {
  return on
    ? <span className="badge-green">{yes}</span>
    : <span className="badge-slate">{no}</span>;
}

export default async function SettingsPage() {
  const s = await apiFetch<AdminSettings>('/v1/admin/settings');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">
          Read-only summary of the API process environment. Secret values are never returned.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Process</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">NODE_ENV</dt>      <dd>{s.node_env}</dd>
            <dt className="text-slate-500">APP_VERSION</dt>   <dd className="font-mono text-xs">{s.app_version}</dd>
            <dt className="text-slate-500">PUBLIC_WEB_URL</dt><dd className="break-all">{s.public_web_url ?? <em className="text-slate-400">unset</em>}</dd>
            <dt className="text-slate-500">PUBLIC_API_URL</dt><dd className="break-all">{s.public_api_url ?? <em className="text-slate-400">unset</em>}</dd>
            <dt className="text-slate-500">CORS_ORIGIN</dt>
            <dd>
              {s.cors_origins.length === 0
                ? <em className="text-slate-400">deny all</em>
                : <code className="text-xs">{s.cors_origins.join(', ')}</code>}
            </dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Stripe</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Secret key</dt>
            <dd><YesNo on={s.stripe_configured} /></dd>
            <dt className="text-slate-500">MRR price (cents)</dt>
            <dd>{s.stripe_price_amount_cents != null ? s.stripe_price_amount_cents : <em className="text-slate-400">unset</em>}</dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Email</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Provider</dt>
            <dd>{s.email.provider ?? <em className="text-slate-400">disabled</em>}</dd>
            <dt className="text-slate-500">From</dt>
            <dd className="break-all">{s.email.from ?? <em className="text-slate-400">unset</em>}</dd>
            <dt className="text-slate-500">SMTP</dt>
            <dd><YesNo on={s.email.smtp_configured} /></dd>
            <dt className="text-slate-500">Microsoft Graph</dt>
            <dd><YesNo on={s.email.graph_configured} /></dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">OAuth</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Sign in with Apple</dt>
            <dd><YesNo on={s.oauth.apple_configured} /></dd>
            <dt className="text-slate-500">Sign in with Google</dt>
            <dd><YesNo on={s.oauth.google_configured} /></dd>
            <dt className="text-slate-500">Google audiences</dt>
            <dd>
              {s.oauth.google_audiences.length === 0
                ? <em className="text-slate-400">none</em>
                : s.oauth.google_audiences.join(', ')}
            </dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">MQTT</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Public host</dt>
            <dd>{s.mqtt.public_host ?? <em className="text-slate-400">unset</em>}</dd>
            <dt className="text-slate-500">Public port</dt>
            <dd>{s.mqtt.public_port}</dd>
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">OTA signing</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">Signing key</dt>
            <dd><YesNo on={s.ota.signing_key_configured} yes="loaded" no="missing" /></dd>
          </dl>
        </div>
      </div>
    </div>
  );
}
