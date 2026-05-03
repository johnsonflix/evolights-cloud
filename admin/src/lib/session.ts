/**
 * Server-only session helpers.
 *
 * The admin app stores the API JWT in an HttpOnly cookie set by Next.js
 * Route Handlers / Server Actions; client JS NEVER sees the token. Every
 * server-side data fetch reads the cookie via `next/headers` and forwards
 * it as `Authorization: Bearer <token>` to the api.
 */
import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'evo_admin_session';
// 7 days in seconds — matches the JWT `expiresIn` configured in
// api/src/lib/jwt.ts. Keep these in sync; if you bump the API, bump here.
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface SessionPayload {
  token: string;
  // Email captured at login time so we can show "logged in as ..." without
  // an extra /v1/me round-trip on every page render.
  email: string;
  // ms-since-epoch when we wrote the cookie — used for soft expiry / debug.
  issued_at: number;
}

export async function getSession(): Promise<SessionPayload | null> {
  // cookies() is async in Next.js 15.
  const c = await cookies();
  const raw = c.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    if (typeof parsed.token !== 'string' || typeof parsed.email !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    // Malformed cookie → treat as logged out. Will be cleared on next set.
    return null;
  }
}

export async function setSession(payload: SessionPayload): Promise<void> {
  const c = await cookies();
  c.set(SESSION_COOKIE, JSON.stringify(payload), {
    // HttpOnly so client JS cannot exfiltrate the token even if XSS lands.
    httpOnly: true,
    // SameSite=Lax blocks cross-site POSTs that try to ride the cookie
    // (CSRF defence) while still allowing top-level navigations.
    sameSite: 'lax',
    // Production-only Secure: in dev (http://localhost) we'd never set the
    // cookie if Secure was forced.
    secure:   process.env.NODE_ENV === 'production',
    path:     '/',
    maxAge:   SESSION_TTL_SECONDS,
  });
}

export async function clearSession(): Promise<void> {
  const c = await cookies();
  c.delete(SESSION_COOKIE);
}
