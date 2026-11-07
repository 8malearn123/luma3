import { SiteFooter, SiteHeader } from '@/ui/marketing/SiteHeader';

export const metadata = { title: { default: 'سوق لوما', template: '%s · سوق لوما' } };

/** سوق لوما (LUMA marketplace): public, LUMA identity. */
export default function DiscoverLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main">{children}</main>
      <SiteFooter />
    </>
  );
}
