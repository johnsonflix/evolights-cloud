import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';
import { formatCurrency } from '@/lib/format';
import type { StripePrice, StripeProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

const priceSchema = z.object({
  product_id:         z.string().min(1).max(255),
  currency:           z.string().length(3),
  // Form value is a decimal-dollar string; we convert to cents server-side.
  unit_amount:        z.number().int().min(0),
  recurring_interval: z.enum(['day', 'week', 'month', 'year']),
});

interface PageProps {
  searchParams: Promise<{ product?: string }>;
}

export default async function PricesPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const productFilter = params.product?.trim();

  let prices: StripePrice[] = [];
  let products: StripeProduct[] = [];
  let listError: string | null = null;
  try {
    const [pricesRes, productsRes] = await Promise.all([
      apiFetch<{ prices: StripePrice[] }>(
        `/v1/admin/stripe/prices${productFilter ? `?product_id=${encodeURIComponent(productFilter)}` : ''}`,
      ),
      apiFetch<{ products: StripeProduct[] }>('/v1/admin/stripe/products'),
    ]);
    prices   = pricesRes.prices;
    products = productsRes.products;
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) {
      listError = 'Stripe is not configured (STRIPE_SECRET_KEY unset).';
    } else if (e instanceof ApiError) {
      listError = `Stripe error ${e.status}: ${JSON.stringify(e.body)}`;
    } else throw e;
  }

  async function createPrice(formData: FormData) {
    'use server';
    const dollars = Number(formData.get('unit_amount_dollars') ?? 0);
    const parsed = priceSchema.safeParse({
      product_id:         String(formData.get('product_id') ?? '').trim(),
      currency:           String(formData.get('currency') ?? 'usd').trim().toLowerCase(),
      unit_amount:        Math.round(dollars * 100),
      recurring_interval: String(formData.get('recurring_interval') ?? 'month'),
    });
    if (!parsed.success) {
      revalidatePath('/stripe/prices');
      return;
    }
    try {
      await apiFetch('/v1/admin/stripe/prices', { method: 'POST', body: parsed.data });
    } catch {
      // see products page note re error surfacing
    }
    revalidatePath('/stripe/prices');
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Stripe prices</h1>
          <p className="text-sm text-slate-500">{prices.length} loaded · max 100</p>
        </div>

        <form className="flex items-end gap-2" action="/stripe/prices" method="get">
          <div>
            <label className="label" htmlFor="filter-product">Filter by product</label>
            <select id="filter-product" name="product" defaultValue={productFilter ?? ''} className="input w-72">
              <option value="">All products</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-secondary">Filter</button>
        </form>
      </div>

      {listError && <div className="card border-red-200 bg-red-50 text-sm text-red-700">{listError}</div>}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Create price</h2>
        <form action={createPrice} className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="np-product">Product</label>
            <select id="np-product" name="product_id" required className="input">
              <option value="">Select…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="np-currency">Currency</label>
            <input id="np-currency" name="currency" defaultValue="usd" maxLength={3} required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="np-amount">Amount (decimal)</label>
            <input id="np-amount" name="unit_amount_dollars" type="number" step="0.01" min="0" required className="input" />
          </div>
          <div>
            <label className="label" htmlFor="np-interval">Interval</label>
            <select id="np-interval" name="recurring_interval" defaultValue="month" required className="input">
              <option value="day">day</option>
              <option value="week">week</option>
              <option value="month">month</option>
              <option value="year">year</option>
            </select>
          </div>
          <div className="flex items-end sm:col-span-3">
            <button type="submit" className="btn-primary">Create</button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Price ID</th>
              <th>Product</th>
              <th>Amount</th>
              <th>Interval</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {prices.length === 0 && !listError && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">No prices yet.</td></tr>
            )}
            {prices.map((pr) => (
              <tr key={pr.id}>
                <td className="font-mono text-xs">{pr.id}</td>
                <td className="font-mono text-xs">{pr.product}</td>
                <td>{formatCurrency(pr.unit_amount, pr.currency)}</td>
                <td>{pr.recurring ? `every ${pr.recurring.interval_count ?? 1} ${pr.recurring.interval}` : 'one-time'}</td>
                <td>{pr.active ? <span className="badge-green">active</span> : <span className="badge-slate">archived</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
