import { MfaPrompt } from '@/ui/platform/Security';
import { safeInternalPath } from '@/shared/safe-path';
import { requirePlatformPage } from '@/server/domains/platform/page-guard';

export const metadata = { title: 'Verify' };

/** Second-factor prompt; the layout renders it without navigation (gate mode). */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const next = safeInternalPath(sp.next, '/platform', '/platform');
  // Staff who have not set up MFA yet enrol here: every other admin page (security included) is behind this gate.
  const { mfa } = await requirePlatformPage({ allowUnverified: true });
  return <MfaPrompt next={next} enrolled={mfa.enabled} />;
}
