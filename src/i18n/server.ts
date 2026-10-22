import { cookies, headers } from 'next/headers';
import { makeT, type Locale } from './index';

export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get('luma_locale')?.value;
  if (c === 'ar' || c === 'en') return c;
  const al = (await headers()).get('accept-language') ?? '';
  return al.toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export async function getT() {
  const locale = await getLocale();
  return { locale, t: makeT(locale) };
}
