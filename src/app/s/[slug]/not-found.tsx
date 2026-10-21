import { headers } from 'next/headers';
import { getLocale } from '@/i18n/server';
import { translate } from '@/i18n';

/** Rendered inside the storefront layout (theme + navigation stay) for unknown or hidden items. */
export default async function StorefrontNotFound() {
  const locale = await getLocale();
  const path = (await headers()).get('x-pathname') ?? '';
  const slug = path.split('/')[2];
  return (
    <section className="px-4 py-16 text-center sm:px-6">
      <h1 className="font-sf-heading text-2xl font-semibold">{translate(locale, 'storefront.not_found')}</h1>
      <p className="mt-2 text-sf-muted">{translate(locale, 'storefront.not_found_hint')}</p>
      {slug ? <a href={`/s/${slug}/services`} className="mt-4 inline-block rounded-sf bg-sf-primary px-5 py-2.5 text-sm font-semibold text-sf-on-primary">{translate(locale, 'storefront.services')}</a> : null}
    </section>
  );
}
