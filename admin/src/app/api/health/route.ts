/**
 * Container healthcheck endpoint.
 *
 * Probes the upstream API by hitting its public /health (which doesn't
 * require auth). Returns 200 only if both the admin process is alive AND
 * the API is reachable from inside the docker network — matches what the
 * docker-compose healthcheck cares about.
 */

import { NextResponse } from 'next/server';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://api:8080';

export async function GET() {
  let apiOk = false;
  try {
    const res = await fetch(`${API_BASE_URL}/health`, {
      cache: 'no-store',
      // Short timeout so a wedged API doesn't hold healthcheck threads open.
      signal: AbortSignal.timeout(2000),
    });
    apiOk = res.ok;
  } catch {
    apiOk = false;
  }
  return NextResponse.json(
    {
      service: 'evolights-cloud-admin',
      ok:      true,
      api_ok:  apiOk,
    },
    { status: apiOk ? 200 : 503 },
  );
}
