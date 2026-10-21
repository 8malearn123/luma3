import { notFound } from 'next/navigation';
import { db } from '@/server/db/client';
import { env } from '@/server/env';
import { requireUser } from '@/server/pages';
import { SandboxCheckout } from '@/ui/booking/SandboxCheckout';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sandbox payment', robots: { index: false } };

/** LUMA Sandbox hosted checkout — a SIMULATION, disabled in production. */
export default async function SandboxPage({ params, searchParams }: { params: Promise<{ providerPaymentId: string }>; searchParams: Promise<{ return?: string }> }) {
  if (env().isProduction) notFound();
  const { providerPaymentId } = await params;
  const { return: ret } = await searchParams;
  await requireUser(`/sandbox/checkout/${providerPaymentId}`);
  const p = await db().selectFrom('sandbox_provider_payments').select(['id', 'amount_minor', 'currency', 'status']).where('id', '=', providerPaymentId).executeTakeFirst();
  if (!p) notFound();
  const safeReturn = ret && ret.startsWith('/') && !ret.startsWith('//') ? ret : '/account';
  return <SandboxCheckout id={p.id} amountMinor={p.amount_minor} currency={p.currency} status={p.status} returnTo={safeReturn} />;
}
