import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAdminSession } from '@/lib/auth';
import { clearSession } from '@/lib/session';

/**
 * Authenticated admin shell. Every page under (admin)/ inherits this and
 * therefore the requireAdminSession() gate. Server-rendered nav so admin
 * checks happen before any HTML reaches the browser.
 */

const NAV: Array<{ href: string; label: string }> = [
  { href: '/',                label: 'Dashboard' },
  { href: '/users',           label: 'Users' },
  { href: '/devices',         label: 'Devices' },
  { href: '/firmware',        label: 'Firmware' },
  { href: '/stripe/products', label: 'Products' },
  { href: '/stripe/prices',   label: 'Prices' },
  { href: '/stripe/coupons',  label: 'Coupons' },
  { href: '/settings',        label: 'Settings' },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { email } = await requireAdminSession();

  async function logout() {
    'use server';
    await clearSession();
    redirect('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-200 px-4 py-4">
          <div className="text-sm font-semibold text-slate-900">
            {process.env.NEXT_PUBLIC_BRAND ?? 'EvoLights'} Admin
          </div>
          <div className="mt-0.5 truncate text-xs text-slate-500" title={email}>{email}</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <form action={logout} className="border-t border-slate-200 p-3">
          <button type="submit" className="btn-secondary w-full">Log out</button>
        </form>
      </aside>

      <main className="flex-1 overflow-x-auto px-6 py-6">{children}</main>
    </div>
  );
}
