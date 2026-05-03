/**
 * Server-only API client.
 *
 * All calls flow through here so we have one place that:
 *   - reads API_BASE_URL (the internal docker network address of the api),
 *   - attaches the JWT from the session cookie,
 *   - normalises error envelopes to a thrown ApiError,
 *   - opts out of Next.js fetch caching (admin data is volatile).
 */
import { getSession } from './session';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://api:8080';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `api ${status}`);
  }
}

export interface ApiOpts {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  // If true, do NOT attach the session bearer (used by login flow).
  unauthenticated?: boolean;
  // Override the bearer (used by login: we have the token but no cookie yet).
  bearer?: string;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: ApiOpts = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };

  if (!opts.unauthenticated) {
    const bearer = opts.bearer ?? (await getSession())?.token;
    if (!bearer) {
      throw new ApiError(401, { error: 'no_session' }, 'no admin session');
    }
    headers.Authorization = `Bearer ${bearer}`;
  } else if (opts.bearer) {
    headers.Authorization = `Bearer ${opts.bearer}`;
  }

  const url = `${API_BASE_URL}${path}`;
  const res = await fetch(url, {
    method:  opts.method ?? 'GET',
    headers,
    body:    opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    // Admin data is mutable; never serve from cache.
    cache:   'no-store',
  });

  // Try JSON first — every API endpoint returns JSON. Fall back to text on
  // weird upstream errors (502 from a reverse proxy etc.).
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    throw new ApiError(res.status, parsed);
  }
  return parsed as T;
}
