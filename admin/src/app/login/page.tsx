import { redirect } from 'next/navigation';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';
import { getSession, setSession } from '@/lib/session';
import type { MeResponse } from '@/lib/types';

/**
 * /login — pure server-rendered HTML form. No client JS needed.
 *
 * Uses a Server Action (the inline async function passed to <form action>)
 * so the credentials POST never round-trips through the browser; the JWT
 * we receive from the API is written straight to an HttpOnly cookie and
 * the user is redirected to the dashboard.
 *
 * Server Actions get CSRF protection automatically: Next.js validates an
 * action ID on every POST, which an attacker cross-origin cannot forge.
 */

const credSchema = z.object({
  email:    z.string().email().max(255),
  password: z.string().min(8).max(128),
});

interface PageProps {
  searchParams: Promise<{ error?: string; from?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // If we already have a working admin session, skip the form.
  const existing = await getSession();
  if (existing) {
    try {
      await apiFetch('/v1/admin/stats');
      redirect('/');
    } catch {
      // Session exists but isn't admin / is stale — fall through to form.
    }
  }

  async function login(formData: FormData) {
    'use server';
    const parsed = credSchema.safeParse({
      email:    String(formData.get('email')    ?? '').trim().toLowerCase(),
      password: String(formData.get('password') ?? ''),
    });
    if (!parsed.success) {
      redirect('/login?error=invalid_payload');
    }

    let token: string;
    try {
      const res = await apiFetch<{ token: string; user: { id: string; email: string } }>(
        '/v1/auth/login',
        { method: 'POST', body: parsed.data, unauthenticated: true },
      );
      token = res.token;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        redirect('/login?error=invalid_credentials');
      }
      if (e instanceof ApiError && e.status === 429) {
        redirect('/login?error=rate_limited');
      }
      redirect('/login?error=unknown');
    }

    // Confirm admin BEFORE persisting the cookie so we don't paint a
    // logged-in shell to a non-admin user.
    let me: MeResponse;
    try {
      me = await apiFetch<MeResponse>('/v1/me', { bearer: token });
    } catch {
      redirect('/login?error=session_check_failed');
    }
    try {
      await apiFetch('/v1/admin/stats', { bearer: token });
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        redirect('/login?error=admin_only');
      }
      redirect('/login?error=admin_check_failed');
    }

    await setSession({
      token,
      email:     me.email,
      issued_at: Date.now(),
    });
    redirect('/');
  }

  const errorMessages: Record<string, string> = {
    invalid_payload:      'Email or password is malformed.',
    invalid_credentials:  'Email or password is incorrect.',
    rate_limited:         'Too many attempts. Wait a few minutes and try again.',
    session_check_failed: 'Logged in but could not verify session — try again.',
    admin_check_failed:   'Logged in but admin check failed — try again.',
    admin_only:           'This account is not an admin. Promote it via npm run admin:promote.',
    unknown:              'Login failed. Try again.',
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="text-2xl font-semibold text-slate-900">
            {process.env.NEXT_PUBLIC_BRAND ?? 'EvoLights'} Admin
          </div>
          <div className="mt-1 text-sm text-slate-500">Operator console</div>
        </div>

        <form action={login} className="card space-y-4">
          {params.error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
              {errorMessages[params.error] ?? params.error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="label">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              className="input"
            />
          </div>

          <div>
            <label htmlFor="password" className="label">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              minLength={8}
              maxLength={128}
              className="input"
            />
          </div>

          <button type="submit" className="btn-primary w-full">Sign in</button>

          <p className="text-center text-xs text-slate-500">
            Admin access only. Promote a user with{' '}
            <code className="rounded bg-slate-100 px-1">npm run admin:promote</code>.
          </p>
        </form>
      </div>
    </div>
  );
}
