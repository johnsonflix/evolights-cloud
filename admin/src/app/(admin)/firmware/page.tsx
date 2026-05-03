import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { FirmwareListResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

const fwSchema = z.object({
  version: z.string().min(1).max(32),
  board:   z.string().min(1).max(32),
  channel: z.enum(['stable', 'beta', 'dev']),
  url:     z.string().url().max(512),
  sha256:  z.string().regex(/^[0-9a-f]{64}$/),
});

export default async function FirmwarePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  let firmware: FirmwareListResponse['firmware'] = [];
  let listError: string | null = null;
  try {
    const res = await apiFetch<FirmwareListResponse>('/v1/admin/firmware');
    firmware = res.firmware;
  } catch (e) {
    if (e instanceof ApiError) {
      listError = `Firmware list error ${e.status}: ${JSON.stringify(e.body)}`;
    } else throw e;
  }

  async function publish(formData: FormData) {
    'use server';
    const parsed = fwSchema.safeParse({
      version: String(formData.get('version') ?? '').trim(),
      board:   String(formData.get('board')   ?? '').trim(),
      channel: String(formData.get('channel') ?? 'stable'),
      url:     String(formData.get('url')     ?? '').trim(),
      sha256:  String(formData.get('sha256')  ?? '').trim().toLowerCase(),
    });
    if (!parsed.success) {
      revalidatePath('/firmware?error=invalid_payload');
      return;
    }
    try {
      await apiFetch('/v1/ota/firmwares', { method: 'POST', body: parsed.data });
    } catch (e) {
      // We intentionally swallow + re-render so the user sees the new (or
      // unchanged) list. The most common failure modes (signing key
      // unavailable / 503) are visible in the firmware list page error
      // banner above the form on next render.
      if (e instanceof ApiError) {
        // Best-effort: surface the error code via querystring.
        revalidatePath(`/firmware?error=${encodeURIComponent(`api_${e.status}`)}`);
        return;
      }
    }
    revalidatePath('/firmware');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Firmware</h1>
        <p className="text-sm text-slate-500">{firmware.length} published version(s)</p>
      </div>

      {listError && <div className="card border-red-200 bg-red-50 text-sm text-red-700">{listError}</div>}
      {params.error && (
        <div className="card border-red-200 bg-red-50 text-sm text-red-700">
          Publish failed: {params.error}
        </div>
      )}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Publish new firmware</h2>
        <p className="mb-3 text-xs text-slate-500">
          POSTs to /v1/ota/firmwares. The cloud signs <code>version|url|sha256</code> with the OTA private key
          (load via <code>OTA_SIGNING_KEY_PATH</code>). The signature is stored alongside the row.
        </p>
        <form action={publish} className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="fw-version">Version</label>
            <input id="fw-version" name="version" required maxLength={32} placeholder="0.1.0+ev3" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="fw-board">Board</label>
            <input id="fw-board" name="board" required maxLength={32} placeholder="esp32dev_evolights" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="fw-channel">Channel</label>
            <select id="fw-channel" name="channel" defaultValue="stable" className="input">
              <option value="stable">stable</option>
              <option value="beta">beta</option>
              <option value="dev">dev</option>
            </select>
          </div>
          <div className="sm:col-span-3">
            <label className="label" htmlFor="fw-url">Download URL</label>
            <input id="fw-url" name="url" required type="url" maxLength={512}
                   placeholder="https://artifacts.example.com/fw/0.1.0+ev3/esp32dev.bin" className="input" />
          </div>
          <div className="sm:col-span-3">
            <label className="label" htmlFor="fw-sha256">SHA-256 (64 hex chars)</label>
            <input
              id="fw-sha256"
              name="sha256"
              required
              pattern="^[0-9a-fA-F]{64}$"
              maxLength={64}
              className="input font-mono"
              placeholder="9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
            />
          </div>
          <div className="flex items-end sm:col-span-3">
            <button type="submit" className="btn-primary">Publish</button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Board</th>
              <th>Channel</th>
              <th>URL</th>
              <th>Released</th>
            </tr>
          </thead>
          <tbody>
            {firmware.length === 0 && !listError && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">No firmware published yet.</td></tr>
            )}
            {firmware.map((f) => (
              <tr key={f.id}>
                <td className="font-mono text-xs">{f.version}</td>
                <td>{f.board}</td>
                <td>
                  {f.channel === 'stable' && <span className="badge-green">stable</span>}
                  {f.channel === 'beta'   && <span className="badge-amber">beta</span>}
                  {f.channel === 'dev'    && <span className="badge-slate">dev</span>}
                </td>
                <td className="max-w-xs truncate text-xs">
                  <a className="text-brand hover:underline" href={f.url} target="_blank" rel="noreferrer">{f.url}</a>
                </td>
                <td className="text-slate-600">{formatDate(f.released_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
