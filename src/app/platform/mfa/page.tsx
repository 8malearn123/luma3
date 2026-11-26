import { MfaPrompt } from '@/ui/platform/Security';
import { safeInternalPath } from '@/shared/safe-path';
import { demoMfa } from '@/server/domains/platform/mfa';
import { requirePlatformPage } from '@/server/domains/platform/page-guard';
import { channelStatus } from '@/server/infra/messaging';

export const metadata = { title: 'Verify' };

/** Second-factor prompt; the layout renders it without navigation (gate mode). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeInternalPath(sp.next, '/platform', '/platform');
  const { mfa } = await requirePlatformPage({ allowUnverified: true });
  // Authenticator app enrolled: only its codes count. Otherwise WhatsApp when a provider (or the local
  // development echo) can deliver, and authenticator-app setup — the only factor on a deployed build
  // without messaging. The fixed demo code exists only on the LOCAL embedded demo.
  return <MfaPrompt next={next} demo={demoMfa()} totp={mfa.enabled} whatsapp={channelStatus('whatsapp') !== 'disconnected'} />;
}
