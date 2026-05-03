import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import type { AdminUserDetail } from '@/lib/types';
import ConfirmDeleteButton from './confirm-delete-button';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function UserDetailPage({ params }: PageProps) {
  const { id } = await params;
  const detail = await apiFetch<AdminUserDetail>(`/v1/admin/users/${id}`);
  const u = detail.user;

  // Each Server Action revalidates the same page so the UI re-fetches
  // /v1/admin/users/:id after the mutation lands.
  async function promote() {
    'use server';
    await apiFetch(`/v1/admin/users/${id}/promote`, { method: 'POST' });
    revalidatePath(`/users/${id}`);
  }
  async function demote() {
    'use server';
    await apiFetch(`/v1/admin/users/${id}/demote`, { method: 'POST' });
    revalidatePath(`/users/${id}`);
  }
  async function logoutEverywhere() {
    'use server';
    await apiFetch(`/v1/admin/users/${id}/logout-everywhere`, { method: 'POST' });
    revalidatePath(`/users/${id}`);
  }
  async function softDelete() {
    'use server';
    await apiFetch(`/v1/admin/users/${id}`, { method: 'DELETE' });
    redirect('/users');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm">
            <Link href="/users" className="text-slate-500 hover:underline">Users</Link>
            <span className="mx-1 text-slate-400">/</span>
            <span className="font-medium text-slate-900">{u.email}</span>
          </div>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{u.email}</h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {u.is_admin       && <span className="badge-amber">admin</span>}
            {u.email_verified && <span className="badge-green">verified</span>}
            {u.has_password   && <span className="badge-slate">password</span>}
            {u.has_apple      && <span className="badge-slate">apple</span>}
            {u.has_google     && <span className="badge-slate">google</span>}
            {u.deleted_at     && <span className="badge-red">deleted</span>}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!u.is_admin && (
            <form action={promote}>
              <button type="submit" className="btn-secondary">Promote to admin</button>
            </form>
          )}
          {u.is_admin && (
            <form action={demote}>
              <button type="submit" className="btn-secondary">Demote</button>
            </form>
          )}
          <form action={logoutEverywhere}>
            <button type="submit" className="btn-secondary">Log out everywhere</button>
          </form>
          {!u.deleted_at && (
            <form action={softDelete}>
              <ConfirmDeleteButton />
            </form>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Account</h2>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-slate-500">User ID</dt>
            <dd className="font-mono text-xs">{u.id}</dd>
            <dt className="text-slate-500">Created</dt>
            <dd>{formatDate(u.created_at)}</dd>
            <dt className="text-slate-500">Updated</dt>
            <dd>{formatDate(u.updated_at)}</dd>
            <dt className="text-slate-500">Tokens valid after</dt>
            <dd>{formatDate(u.tokens_valid_after)}</dd>
            {u.deleted_at && (
              <>
                <dt className="text-slate-500">Soft-deleted at</dt>
                <dd>{formatDate(u.deleted_at)}</dd>
              </>
            )}
          </dl>
        </div>

        <div className="card">
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Subscription</h2>
          {detail.subscription ? (
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-slate-500">Status</dt>
              <dd className="font-medium">{detail.subscription.status}</dd>
              <dt className="text-slate-500">Customer</dt>
              <dd className="font-mono text-xs break-all">{detail.subscription.stripe_customer_id}</dd>
              <dt className="text-slate-500">Sub ID</dt>
              <dd className="font-mono text-xs break-all">{detail.subscription.stripe_sub_id ?? '—'}</dd>
              <dt className="text-slate-500">Period end</dt>
              <dd>{formatDate(detail.subscription.current_period_end)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No subscription on record.</p>
          )}
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="border-b border-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
          Devices ({detail.devices.length})
        </div>
        {detail.devices.length === 0 ? (
          <p className="px-3 py-4 text-sm text-slate-500">No paired devices.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Hardware ID</th>
                <th>Firmware</th>
                <th>Last seen</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {detail.devices.map((d) => (
                <tr key={d.id}>
                  <td className="font-medium">{d.name}</td>
                  <td className="font-mono text-xs">{d.hardware_id}</td>
                  <td>{d.firmware_version ?? '—'}</td>
                  <td className="text-slate-600">{formatRelative(d.last_seen_at)}</td>
                  <td className="text-slate-600">{formatRelative(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
