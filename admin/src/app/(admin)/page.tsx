import { apiFetch } from '@/lib/api';
import { formatCents } from '@/lib/format';
import type { AdminStats } from '@/lib/types';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export default async function DashboardPage() {
  const stats = await apiFetch<AdminStats>('/v1/admin/stats');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500">Live snapshot from /v1/admin/stats.</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total users"   value={stats.users_count.toLocaleString()} />
        <StatCard label="Total devices" value={stats.devices_count.toLocaleString()} />
        <StatCard
          label="Active subscriptions"
          value={stats.active_subscriptions.toLocaleString()}
          hint="active | trialing | past_due"
        />
        <StatCard
          label="MRR (estimate)"
          value={formatCents(stats.mrr_cents)}
          hint={stats.mrr_cents == null ? 'Set STRIPE_PRICE_AMOUNT_CENTS to enable' : 'subs × monthly price'}
        />
        <StatCard
          label="New signups (24h)"
          value={stats.last_24h_signups.toLocaleString()}
        />
        <StatCard
          label="Pairings completed (24h)"
          value={stats.last_24h_pairings.toLocaleString()}
        />
      </div>
    </div>
  );
}
