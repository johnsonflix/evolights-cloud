'use client';

import Link from 'next/link';

/**
 * Tiny client component for tab navigation.
 *
 * Tabs swap via querystring (?tab=email) so each tab is a fresh server-
 * rendered fetch of /v1/admin/settings -- avoids stale data after the
 * Server Action save and keeps render uniform with the rest of the
 * admin app. No client-side state.
 */
export default function SettingsTabs({
  tabs,
  active,
}: {
  tabs: Array<{ key: string; label: string }>;
  active: string;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-slate-200">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={`/settings?tab=${encodeURIComponent(t.key)}`}
            className={
              'rounded-t-md px-3 py-2 text-sm transition ' +
              (isActive
                ? 'border border-b-white border-slate-200 bg-white font-semibold text-slate-900'
                : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
