import { LumaLogo } from '@/ui/components/brand';
import { UnsubscribeForm } from '@/ui/account/UnsubscribeForm';

export const metadata = { title: 'Unsubscribe', robots: { index: false } };

/** Public, login-free unsubscribe page for marketing email links: /unsubscribe?token=… */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const sp = await searchParams;
  const token = typeof sp.token === 'string' && sp.token.length >= 20 && sp.token.length <= 1000 ? sp.token : null;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-luma-50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-sm">
        <LumaLogo className="mx-auto mb-4 h-10 w-auto" />
        <UnsubscribeForm token={token} />
      </div>
    </div>
  );
}
