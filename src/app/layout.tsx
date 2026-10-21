import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getLocale } from '@/i18n/server';
import { dir } from '@/i18n';
import { Providers } from '@/ui/providers';
import { getSessionUser } from '@/server/pages';

export const metadata: Metadata = {
  title: { default: 'LUMA — لوما', template: '%s · LUMA' },
  description: 'LUMA — Your Beauty, Our Expertise. منصة الصالونات والخبيرات.',
  icons: { icon: '/brand/luma-mark.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#5B3764' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const user = await getSessionUser().catch(() => null);
  return (
    <html lang={locale} dir={dir(locale)}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* LUMA identity fonts from the brand guide: IBM Plex Sans Arabic, Cinzel, EB Garamond */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Cinzel:wght@400;600&family=EB+Garamond:wght@500;700&display=swap" />
      </head>
      <body>
        <Providers locale={locale} timeFormat={user?.timeFormat ?? '12h'}>{children}</Providers>
      </body>
    </html>
  );
}
