import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import type { AdminUsersResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string }>;
}

const PAGE_SIZE = 50;

function SubBadge({ status }: { status: string | null }) {
  if (!status) return <span className="badge-slate">none</span>;
  if (status === 'active' || status === 'trialing') return <span className="badge-green">{status}</span>;
  if (status === 'past_due') return <span className="badge-amber">{status}</span>;
  return <span className="badge-red">{status}</span>;
}

export default async function UsersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const q = params.q?.trim() ?? '';
  const page = Math.max(1, Number(params.page ?? 1) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  qs.set('limit',  String(PAGE_SIZE));
  qs.set('offset', String(offset));

  const res = await apiFetch<AdminUsersResponse>(`/v1/admin/users?${qs.toString()}`);
  const totalPages = Math.max(1, Math.ceil(res.total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Users</h1>
          <p className="text-sm text-slate-500">{res.total.toLocaleString()} total</p>
        </div>

        {/* GET form so the URL ends up shareable / bookmarkable. */}
        <form className="flex gap-2" action="/users" method="get">
          <input
            name="q"
            placeholder="Search by email…"
            defaultValue={q}
            className="input w-64"
          />
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Sub</th>
              <th>Admin</th>
              <th>Verified</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {res.users.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  No users matched.
                </td>
              </tr>
            )}
            {res.users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/users/${u.id}`} className="font-medium text-brand hover:underline">
                    {u.email}
                  </Link>
                </td>
                <td><SubBadge status={u.sub_status} /></td>
                <td>{u.is_admin ? <span className="badge-amber">admin</span> : <span className="badge-slate">user</span>}</td>
                <td>{u.email_verified ? <span className="badge-green">yes</span> : <span className="badge-slate">no</span>}</td>
                <td className="text-slate-600">{formatRelative(u.created_at)}</td>
                <td>{u.deleted_at ? <span className="badge-red">deleted</span> : <span className="badge-slate">live</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <div>
            Page {page} of {totalPages}
          </div>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={`/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page - 1) }).toString()}`}
                className="btn-secondary"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={`/users?${new URLSearchParams({ ...(q ? { q } : {}), page: String(page + 1) }).toString()}`}
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
