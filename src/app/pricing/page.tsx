import { getT } from '@/i18n/server';
import { SiteFooter, SiteHeader } from '@/ui/marketing/SiteHeader';
import { PricingPlans } from '@/ui/marketing/PricingPlans';
import { publicPricing } from '@/server/domains/platform/pricing';

export const metadata = { title: 'Plans' };
export const dynamic = 'force-dynamic';

/**
 * Plans, prices (monthly / yearly = two months free), the founding-customer
 * offer and running promotions all come from the database (editable by the
 * LUMA owner in /platform/plans).
 */
export default async function Pricing({ searchParams }: { searchParams: Promise<{ promo?: string }> }) {
  const { t } = await getT();
  const { promo } = await searchParams;
  const code = promo && /^[A-Za-z0-9_-]{3,32}$/.test(promo) ? promo : undefined;
  const data = await publicPricing({ promo: code });
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <h1 className="text-center text-3xl font-semibold text-luma-900">{t('site.pricing_title')}</h1>
        <p className="mt-2 text-center text-ink-muted">{t('site.pricing_sub')}</p>
        <PricingPlans data={JSON.parse(JSON.stringify(data))} promo={data.promotion_code?.valid ? code : undefined} />
      </main>
      <SiteFooter />
    </>
  );
}
