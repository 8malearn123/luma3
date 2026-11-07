import { notFound } from 'next/navigation';
import { publicTenant } from '@/server/domains/storefront-public';
import { giftByToken } from '@/server/domains/giftcards/online';
import { AppError } from '@/server/http/errors';
import { GiftCardView } from '@/ui/storefront/OnlinePurchase';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Gift card', robots: { index: false, follow: false }, referrer: 'no-referrer' as const };

/** The recipient's private gift page (reached only through the link in her message). */
export default async function Page({ params }: { params: Promise<{ slug: string; token: string }> }) {
  const { slug, token } = await params;
  let tenant;
  let gift;
  try {
    tenant = await publicTenant(slug);
    gift = await giftByToken(tenant.id, token);
  } catch (e) { if (e instanceof AppError) notFound(); throw e; }
  return <GiftCardView slug={slug} tenantName={tenant.name} gift={{ ...gift, expires_at: gift.expires_at ? gift.expires_at.toISOString() : null }} />;
}
