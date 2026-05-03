import { revalidatePath } from 'next/cache';
import { apiFetch } from '@/lib/api';
import type { AdminSettingsResponse, SettingGroup, SettingView } from '@/lib/types';
import SettingsTabs from './settings-tabs';

export const dynamic = 'force-dynamic';

/**
 * Editable runtime-settings page.
 *
 * Replaces the previous read-only env summary. Source of truth is now the
 * api's app_settings table (see api/src/lib/settings.ts); env vars become
 * first-boot defaults that the operator can override here without editing
 * .env or restarting containers.
 *
 * Why a Server Component + Server Action (not a client form):
 *   - Render path uses the same apiFetch+session bearer flow as every other
 *     admin page, so the API client never reaches the browser.
 *   - Server Action runs the PATCH server-side (cookie -> bearer ->
 *     apiFetch); no need to expose admin endpoints to the browser via a
 *     proxy route.
 *   - Tabs/state-only interactivity is lifted into a tiny client component
 *     (SettingsTabs); the form posts use plain HTML <form action={...}>.
 */

const TAB_ORDER: SettingGroup[] = [
  'public',
  'branding',
  'email',
  'oauth',
  'stripe',
  'behavior',
  'security',
];

const TAB_LABELS: Record<SettingGroup, string> = {
  public:   'Public',
  branding: 'Branding',
  email:    'Email',
  oauth:    'OAuth',
  stripe:   'Stripe',
  behavior: 'Behavior',
  security: 'Security',
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; saved?: string }>;
}) {
  const sp = await searchParams;
  const activeTab: SettingGroup =
    (TAB_ORDER as string[]).includes(sp.tab ?? '')
      ? (sp.tab as SettingGroup)
      : 'public';
  const justSaved = sp.saved === '1';

  const data = await apiFetch<AdminSettingsResponse>('/v1/admin/settings');

  /**
   * Server Action: handle a tab's form submission.
   *
   * The form posts the entire active tab's fields. We read the registry
   * for that tab from `data.settings` so we know each field's type +
   * secret-ness, parse the FormData values into properly typed JSON, and
   * PATCH the API. Empty strings for secret fields are dropped client-
   * side AND server-side ("leave unchanged" sentinel).
   */
  async function saveTab(formData: FormData): Promise<void> {
    'use server';
    const tab = (formData.get('__tab') as SettingGroup) ?? 'public';
    const fresh = await apiFetch<AdminSettingsResponse>('/v1/admin/settings');
    const tabSettings = fresh.settings.filter((s) => s.group === tab);

    const updates: Array<{ key: string; value: unknown }> = [];
    for (const def of tabSettings) {
      const raw = formData.get(def.key);
      // <input> always returns a string (or null if absent). Convert to
      // the registry's typed shape; CSV / textarea need their own splits.
      let value: unknown;
      switch (def.type) {
        case 'string':
        case 'text':
          value = typeof raw === 'string' ? raw : '';
          break;
        case 'enum':
          value = typeof raw === 'string' ? raw : '';
          break;
        case 'number': {
          const s = typeof raw === 'string' ? raw.trim() : '';
          if (s === '') {
            value = null;
          } else {
            const n = Number(s);
            value = Number.isFinite(n) ? n : null;
          }
          break;
        }
        case 'boolean':
          // Checkboxes submit "on" when checked, nothing when unchecked.
          value = raw === 'on' || raw === 'true';
          break;
        case 'csv': {
          const s = typeof raw === 'string' ? raw : '';
          const parts = s
            .split(/[\n,]/)
            .map((x) => x.trim())
            .filter(Boolean);
          value = parts;
          break;
        }
      }

      // Secret-field "leave unchanged" handling: empty string is the
      // sentinel. The PATCH endpoint also enforces this server-side.
      if (def.is_secret && value === '') continue;

      // Allow operators to clear a non-secret string by submitting an
      // empty value -- map "" to null so the api stores nothing and falls
      // back to the env default. The "Reset to default" button below
      // explicitly sends null too.
      if ((def.type === 'string' || def.type === 'text' || def.type === 'enum') && value === '') {
        value = null;
      }

      updates.push({ key: def.key, value });
    }

    if (updates.length > 0) {
      await apiFetch('/v1/admin/settings', { method: 'PATCH', body: { updates } });
    }
    revalidatePath('/settings');
  }

  /**
   * Server Action: clear a single setting (delete its DB row, revert to
   * env default). Posted from the per-row "Reset to default" form.
   */
  async function clearOne(formData: FormData): Promise<void> {
    'use server';
    const key = formData.get('key');
    if (typeof key !== 'string' || !key) return;
    await apiFetch('/v1/admin/settings', {
      method: 'PATCH',
      body: { updates: [{ key, value: null }] },
    });
    revalidatePath('/settings');
  }

  const groupedSettings = new Map<SettingGroup, SettingView[]>();
  for (const g of TAB_ORDER) groupedSettings.set(g, []);
  for (const s of data.settings) groupedSettings.get(s.group)?.push(s);

  const activeTabSettings = groupedSettings.get(activeTab) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-500">
          Runtime configuration. Saved here overrides the matching environment variable;
          leave a non-secret field blank to fall back to the env default.
        </p>
      </div>

      {data.needs_restart && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Restart required.</strong>{' '}
          One or more saved settings won&rsquo;t take effect until the api container
          restarts (currently: CORS origins). Other changes apply immediately.
        </div>
      )}

      {justSaved && (
        <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-900">
          Settings saved.
        </div>
      )}

      <SettingsTabs
        tabs={TAB_ORDER.map((g) => ({ key: g, label: TAB_LABELS[g] }))}
        active={activeTab}
      />

      <form action={saveTab} className="space-y-4">
        <input type="hidden" name="__tab" value={activeTab} />

        {activeTabSettings.length === 0 ? (
          <p className="text-sm text-slate-500">No settings in this group.</p>
        ) : (
          <div className="card space-y-5">
            {activeTabSettings.map((s) => (
              <SettingField key={s.key} setting={s} clearOne={clearOne} />
            ))}
            <div className="flex items-center justify-between border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">
                Changes are persisted to the database. Empty a non-secret field to revert it to
                the env default; for secrets, use &ldquo;Reset to default&rdquo;.
              </p>
              <button type="submit" className="btn-primary">Save {TAB_LABELS[activeTab]}</button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * Render one setting row. Field type determines which widget we draw;
 * secret fields render a placeholder-only input with a help line.
 */
function SettingField({
  setting,
  clearOne,
}: {
  setting: SettingView;
  clearOne: (fd: FormData) => Promise<void>;
}) {
  const id = `s-${setting.key.replace(/\./g, '-')}`;
  const valueStr = formatValue(setting);

  return (
    <div className="grid gap-2 lg:grid-cols-[1fr_2fr]">
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-slate-800">
          {setting.label}
        </label>
        {setting.hint && (
          <p className="mt-0.5 text-xs text-slate-500">{setting.hint}</p>
        )}
        <p className="mt-1 font-mono text-[10px] text-slate-400">{setting.key}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
          {setting.has_db_override && <span className="badge-amber">db override</span>}
          {!setting.has_db_override && setting.is_secret_set && (
            <span className="badge-slate">env default</span>
          )}
          {setting.needs_restart && <span className="badge-red">restart required</span>}
          {setting.is_secret && <span className="badge-slate">secret</span>}
        </div>
        {setting.has_db_override && (setting.updated_at || setting.updated_by_email) && (
          <p className="mt-1 text-[11px] text-slate-500">
            Last changed{' '}
            {setting.updated_at ? new Date(setting.updated_at).toLocaleString() : 'recently'}
            {setting.updated_by_email ? ` by ${setting.updated_by_email}` : ''}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <FieldInput id={id} setting={setting} initialValue={valueStr} />
        {setting.has_db_override && (
          <form action={clearOne}>
            <input type="hidden" name="key" value={setting.key} />
            <button type="submit" className="text-xs text-slate-500 hover:text-slate-800 underline">
              Reset to env default
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Pick an input widget for the field type. All inputs use `name={setting.key}`
 * so the saveTab Server Action can read them by registry key directly.
 */
function FieldInput({
  id,
  setting,
  initialValue,
}: {
  id: string;
  setting: SettingView;
  initialValue: string;
}) {
  const name = setting.key;

  if (setting.is_secret) {
    return (
      <input
        id={id}
        name={name}
        type="password"
        autoComplete="new-password"
        defaultValue=""
        placeholder={setting.is_secret_set ? '*** configured ***' : ''}
        className="input"
      />
    );
  }

  switch (setting.type) {
    case 'boolean':
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            id={id}
            name={name}
            type="checkbox"
            defaultChecked={setting.value === true}
            className="h-4 w-4 rounded border-slate-300"
          />
          <span className="text-slate-600">{setting.value === true ? 'on' : 'off'}</span>
        </label>
      );
    case 'enum': {
      const options = setting.enum_values ?? [];
      return (
        <select id={id} name={name} defaultValue={initialValue} className="input">
          {options.map((o) => (
            <option key={o} value={o}>{o === '' ? '(disabled)' : o}</option>
          ))}
        </select>
      );
    }
    case 'number':
      return (
        <input
          id={id}
          name={name}
          type="number"
          defaultValue={initialValue}
          className="input"
        />
      );
    case 'text':
      return (
        <textarea
          id={id}
          name={name}
          defaultValue={initialValue}
          rows={6}
          className="input font-mono text-xs"
          placeholder={
            setting.key === 'mqtt.ca_cert_pem'
              ? '-----BEGIN CERTIFICATE-----\n...PEM contents...\n-----END CERTIFICATE-----'
              : ''
          }
        />
      );
    case 'csv':
      return (
        <input
          id={id}
          name={name}
          type="text"
          defaultValue={initialValue}
          className="input"
          placeholder="comma-separated, e.g. https://app.evolights.io,https://admin.evolights.io"
        />
      );
    case 'string':
    default:
      return (
        <input
          id={id}
          name={name}
          type="text"
          defaultValue={initialValue}
          className="input"
        />
      );
  }
}

/**
 * Format a setting's current value for display in an input's defaultValue.
 * CSV rendered as comma-separated; null/undefined as empty string.
 */
function formatValue(setting: SettingView): string {
  if (setting.is_secret) return '';
  const v = setting.value;
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
