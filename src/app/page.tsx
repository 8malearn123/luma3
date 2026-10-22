import Link from 'next/link';
import { CalendarCheck, Lightbulb, Palette, ShoppingBag } from 'lucide-react';
import { getT } from '@/i18n/server';
import { SiteFooter, SiteHeader } from '@/ui/marketing/SiteHeader';
import { LumaLogo } from '@/ui/components/brand';

export default async function Home() {
  const { t } = await getT();
  const features = [
    { icon: Palette, k: 'f1' }, { icon: CalendarCheck, k: 'f2' }, { icon: ShoppingBag, k: 'f3' }, { icon: Lightbulb, k: 'f4' },
  ];
  return (
    <>
      <SiteHeader />
      <main>
        <section className="relative overflow-hidden bg-gradient-to-b from-luma-100 via-luma-200/70 to-luma-300/70">
          <div className="luma-pattern absolute inset-0 opacity-70" aria-hidden />
          <div className="relative mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 md:grid-cols-2 md:py-24">
            <div>
              <h1 className="text-4xl font-semibold leading-tight text-luma-900 md:text-5xl">{t('site.hero_title')}</h1>
              <p className="mt-4 max-w-xl text-lg text-luma-900/80">{t('site.hero_body')}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/auth/register?next=/app/new" className="rounded-xl bg-luma-700 px-6 py-3 font-medium text-white shadow-lg shadow-luma-700/20 hover:bg-luma-800">{t('site.hero_cta')}</Link>
                <Link href="/pricing" className="rounded-xl border border-luma-700/30 bg-white/70 px-6 py-3 font-medium text-luma-800">{t('site.hero_secondary')}</Link>
              </div>
            </div>
            <div className="flex justify-center">
              <div className="rounded-[2.5rem] bg-gradient-to-b from-luma-50 to-luma-300 p-10 shadow-2xl shadow-luma-700/20">
                <LumaLogo variant="vertical" className="h-64 w-auto" />
                <p className="mt-3 text-center font-serif text-luma-700" dir="ltr">Your Beauty, Our Expertise.</p>
              </div>
            </div>
          </div>
        </section>
        <section className="mx-auto grid max-w-6xl gap-4 px-4 py-14 sm:grid-cols-2 lg:grid-cols-4">
          {features.map(({ icon: Icon, k }) => (
            <article key={k} className="rounded-2xl border border-luma-200 bg-white p-6">
              <Icon className="size-7 text-luma-500" aria-hidden />
              <h2 className="mt-3 font-semibold text-luma-900">{t(`site.${k}_title`)}</h2>
              <p className="mt-1 text-sm text-ink-muted">{t(`site.${k}_body`)}</p>
            </article>
          ))}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
