import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { AppError } from '@/server/http/errors';
import { resolveShop } from '@/server/domains/commerce/cart-cookie';
import { CartView } from '@/ui/commerce/CartView';

export const metadata = { title: 'Cart', robots: { index: false } };

/**
 * Storefront cart: /s/{slug}/cart and /s/{slug}/cart?add={variantId}&qty={n}.
 * Renders inside the storefront layout (theme tokens) owned by the storefront domain.
 */
export default async function CartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    await resolveShop(slug);
  } catch (e) {
    if (e instanceof AppError && e.status === 404) notFound();
    throw e;
  }
  return <Suspense fallback={null}><CartView slug={slug} /></Suspense>;
}
