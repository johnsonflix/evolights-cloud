/**
 * Admin-gate helpers for Server Components.
 *
 * Layout strategy: instead of running a Next.js middleware that has to call
 * the API on every request (slow + couples the edge to API uptime), we
 * verify admin status in the (admin) layout's Server Component on every
 * page render. Calls /v1/me with the cookie token and redirects to /login
 * unless the user is an admin (sub_status doesn't matter for admin auth —
 * is_admin is checked via the API gate at the route level).
 *
 * For requireAdmin specifically: /v1/me does not currently return
 * `is_admin`, so we cheaply confirm by hitting /v1/admin/stats — any
 * non-admin gets 403, which we map to a redirect.
 */
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from './api';
import { clearSession, getSession } from './session';
import type { MeResponse } from './types';

export async function requireAdminSession(): Promise<{
  me: MeResponse;
  email: string;
}> {
  const session = await getSession();
  if (!session) redirect('/login');

  // /v1/me confirms the JWT is still valid (not revoked, account exists).
  let me: MeResponse;
  try {
    me = await apiFetch<MeResponse>('/v1/me');
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
      // Stale cookie → wipe + bounce to login. Preserves the always-logged-
      // in-or-redirected invariant the rest of the app assumes.
      await clearSession();
      redirect('/login');
    }
    throw e;
  }

  // Admin gate: hit a cheap admin-only endpoint and use 403 as the
  // "you're not an admin" signal.
  try {
    await apiFetch('/v1/admin/stats');
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) {
      redirect('/login?error=admin_only');
    }
    if (e instanceof ApiError && e.status === 401) {
      await clearSession();
      redirect('/login');
    }
    throw e;
  }

  return { me, email: session.email };
}
