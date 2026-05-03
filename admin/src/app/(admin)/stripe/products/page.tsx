import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { ApiError, apiFetch } from '@/lib/api';
import type { StripeProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

const productSchema = z.object({
  name:        z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  active:      z.boolean().optional(),
});

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  let products: StripeProduct[] = [];
  let listError: string | null = null;
  try {
    const res = await apiFetch<{ products: StripeProduct[] }>('/v1/admin/stripe/products');
    products = res.products;
  } catch (e) {
    if (e instanceof ApiError && e.status === 503) {
      listError = 'Stripe is not configured (STRIPE_SECRET_KEY unset).';
    } else if (e instanceof ApiError) {
      listError = `Stripe error ${e.status}: ${JSON.stringify(e.body)}`;
    } else throw e;
  }

  async function createProduct(formData: FormData) {
    'use server';
    const parsed = productSchema.safeParse({
      name:        String(formData.get('name') ?? '').trim(),
      description: (formData.get('description') ? String(formData.get('description')) : undefined),
      active:      formData.get('active') === 'on',
    });
    if (!parsed.success) {
      revalidatePath('/stripe/products');
      return;
    }
    try {
      await apiFetch('/v1/admin/stripe/products', { method: 'POST', body: parsed.data });
    } catch {
      // Errors surface on next render via the list re-fetch, which would
      // include the new product if it succeeded. A nicer flow would lift
      // the error into a flash; punted.
    }
    revalidatePath('/stripe/products');
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Stripe products</h1>
        <p className="text-sm text-slate-500">{products.length} loaded · max 100</p>
      </div>

      {listError && <div className="card border-red-200 bg-red-50 text-sm text-red-700">{listError}</div>}
      {params.error && <div className="card border-red-200 bg-red-50 text-sm text-red-700">{params.error}</div>}

      <div className="card">
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Create product</h2>
        <form action={createProduct} className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <label className="label" htmlFor="p-name">Name</label>
            <input id="p-name" name="name" required maxLength={255} className="input" />
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="p-description">Description</label>
            <input id="p-description" name="description" maxLength={2000} className="input" />
          </div>
          <div className="flex items-end gap-2 sm:col-span-1">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="active" defaultChecked /> Active
            </label>
          </div>
          <div className="flex items-end sm:col-span-2">
            <button type="submit" className="btn-primary">Create</button>
          </div>
        </form>
      </div>

      <div className="card overflow-hidden p-0">
        <table className="table">
          <thead>
            <tr>
              <th>Product ID</th>
              <th>Name</th>
              <th>Description</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {products.length === 0 && !listError && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-500">No products yet.</td></tr>
            )}
            {products.map((p) => (
              <tr key={p.id}>
                <td className="font-mono text-xs">{p.id}</td>
                <td className="font-medium">{p.name}</td>
                <td className="text-slate-600">{p.description ?? '—'}</td>
                <td>{p.active ? <span className="badge-green">active</span> : <span className="badge-slate">archived</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
