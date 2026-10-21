import { MfaPrompt } from '@/ui/platform/Security';

export const metadata = { title: 'Verify' };

/** Second-factor prompt; the layout renders it without navigation (gate mode). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = sp.next && sp.next.startsWith('/platform') && !sp.next.startsWith('//') ? sp.next : '/platform';
  return <MfaPrompt next={next} />;
}
