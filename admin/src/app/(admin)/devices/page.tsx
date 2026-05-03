import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import type { AdminDevicesResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

const PAGE_SIZE = 50;

export default async function DevicesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit',  String(PAGE_SIZE));
  qs.set('offset', String(offset));

  const res = await apiFetch<AdminDevicesResponse>(`/v1/admin/devices?${qs.toString()}`);
  const totalPages = Math.max(1, Math.ceil(res.total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Devices</h1>
          <p className="text-sm text-slate-500">{res.total.toLocaleString()} total across all tenants</p>
        </div>
        <form className="flex gap-2" action="/devices" method="get">
          <input
            name="q"
            placeholder="Search by name, hardware ID, or owner email…"
            defaultValue={q}
            className="input w-80"
          />
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Hardware ID</th>
              <th>Owner</th>
              <th>Firmware</th>
              <th>Last seen</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {res.devices.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  No devices matched.
                </td>
              </tr>
            )}
            {res.devices.map((d) => (
              <tr key={d.id}>
                <td className="font-medium">{d.name}</td>
                <td className="font-mono text-xs">{d.hardware_id}</td>
                <td>
                  <Link href={`/users/${d.user_id}`} className="text-brand hover:underline">
                    {d.user_email}
                  </Link>
                </td>
                <td>{d.firmware_version ?? '—'}</td>
                <td className="text-slate-600">{formatRelative(d.last_seen_at)}</td>
                <td className="text-slate-600">{formatRelative(d.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <div>Page {page} of {totalPages}</div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/devices?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) }).toString()}`}
                className="btn-secondary"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/devices?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) }).toString()}`}
                className="btn-secondary"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
