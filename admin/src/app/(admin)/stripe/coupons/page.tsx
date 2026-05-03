import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/format';
import type { StripeCoupon } from '@/lib/types';

export const dynamic = 'force-dynamic';

const couponSchema = z.object({
  name:               z.string().min(1).max(255),
  percent_off:        z.number().min(0).max(100).optional(),
  amount_off:         z.number().int().min(0).optional(),
  currency:           z.string().length(3).optional(),
  duration:           z.enum(['forever', 'once', 'repeating']),
  duration_in_months: z.number().int().min(1).max(120).optional(),
}).refine(
  (d) => (d.percent_off === undefined) !== (d.amount_off === undefined),
  { message: 'specify exactly one of percent_off or amount_off' },
);

export default async function CouponsPage() {
  let coupons: StripeCoupon[] = [];
  let listError: string | null = null;
  try {
    const res = await apiFetch<{ coupons: StripeCoupon[] }>('/v1/admin/stripe/coupons');
    coupons = res.coupons;
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) {
      listError = 'Stripe is not configured (STRIPE_SECRET_KEY unset).';
    } else if (e instanceof ApiError) {
      listError = `Stripe error ${e.status}: ${JSON.stringify(e.body)}`;
    } else throw e;
  }

  async function createCoupon(formData: FormData) {
    'use server';
    const offType  = String(formData.get('off_type') ?? 'percent');
    const percent  = Number(formData.get('percent_off') ?? 0);
    const amountD  = Number(formData.get('amount_off_dollars') ?? 0);
    const duration = String(formData.get('duration') ?? 'once') as 'forever' | 'once' | 'repeating';
    const months   = Number(formData.get('duration_in_months') ?? 0);
    const parsed = couponSchema.safeParse({
      name:     String(formData.get('name') ?? '').trim(),
      duration,
      ...(offType === 'percent'
        ? { percent_off: percent }
        : { amount_off: Math.round(amountD * 100), currency: String(formData.get('currency') ?? 'usd').toLowerCase() }),
      ...(duration === 'repeating' ? { duration_in_months: months } : {}),
    });
    if (!parsed.success) {
      revalidatePath('/stripe/coupons');
      return;
    }
    try {
      await apiFetch('/v1/admin/stripe/coupons', { method: 'POST', body: parsed.data });
    } catch {
      // see products page note re error surfacing
    }
    revalidatePath('/stripe/coupons');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Stripe coupons</h1>
        <p className="text-sm text-slate-500">{coupons.length} loaded · max 100</p>
      </div>

      {listError && <div className="card border-red-200 bg-red-50 text-sm text-red-700">{listError}</div>}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Create coupon</h2>
        <form action={createCoupon} className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="c-name">Name</label>
            <input id="c-name" name="name" required maxLength={255} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="c-off-type">Discount type</label>
            <select id="c-off-type" name="off_type" defaultValue="percent" className="input">
              <option value="percent">Percent off</option>
              <option value="amount">Amount off</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-percent">Percent off (0–100)</label>
            <input id="c-percent" name="percent_off" type="number" step="1" min="0" max="100" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="c-amount">Amount off (decimal)</label>
            <input id="c-amount" name="amount_off_dollars" type="number" step="0.01" min="0" className="input" />
          </div>
          <div>
            <label className="label" htmlFor="c-currency">Currency (if amount off)</label>
            <input id="c-currency" name="currency" defaultValue="usd" maxLength={3} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="c-duration">Duration</label>
            <select id="c-duration" name="duration" defaultValue="once" className="input">
              <option value="forever">forever</option>
              <option value="once">once</option>
              <option value="repeating">repeating</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="c-months">Months (if repeating)</label>
            <input id="c-months" name="duration_in_months" type="number" step="1" min="1" max="120" className="input" />
          </div>
          <div className="flex items-end sm:col-span-4">
            <button type="submit" className="btn-primary">Create</button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Coupon ID</th>
              <th>Name</th>
              <th>Discount</th>
              <th>Duration</th>
              <th>Valid</th>
            </tr>
          </thead>
          <tbody>
            {coupons.length === 0 && !listError && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">No coupons yet.</td></tr>
            )}
            {coupons.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-xs">{c.id}</td>
                <td>{c.name ?? '—'}</td>
                <td>
                  {c.percent_off != null
                    ? `${c.percent_off}%`
                    : formatCurrency(c.amount_off, c.currency ?? 'usd')}
                </td>
                <td>
                  {c.duration}
                  {c.duration === 'repeating' && c.duration_in_months ? ` (${c.duration_in_months}mo)` : ''}
                </td>
                <td>{c.valid ? <span className="badge-green">valid</span> : <span className="badge-slate">expired</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
