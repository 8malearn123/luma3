import { MfaPrompt } from '@/ui/platform/Security';
import { safeInternalPath } from '@/shared/safe-path';
import { demoMfa } from '@/server/domains/platform/mfa';

export const metadata = { title: 'Verify' };

/** Second-factor prompt; the layout renders it without navigation (gate mode). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeInternalPath(sp.next, '/platform', '/platform');
  // The embedded demo database uses a fixed code instead of a WhatsApp message.
  return <MfaPrompt next={next} demo={demoMfa()} />;
}
