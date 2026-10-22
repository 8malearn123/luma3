import { headers } from 'next/headers';
import { requirePlatformPage } from '@/server/domains/platform/page-guard';
import { PlatformShell } from '@/ui/platform/PlatformShell';

export const metadata = { title: { default: 'LUMA admin', template: '%s · LUMA admin' } };
export const dynamic = 'force-dynamic';

/**
 * LUMA administration shell (LUMA identity). Non-platform users get 404; an
 * admin with MFA enabled must verify this session first (the MFA prompt page
 * renders in "gate" mode without navigation).
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get('x-pathname') ?? '/platform';
  const gate = path.startsWith('/platform/mfa');
  const { user, caps, mfa } = await requirePlatformPage({ allowUnverified: gate });
  return (
    <PlatformShell gate={gate} platform={{ capabilities: [...caps], roles: user.platformRoles, mfa: { enabled: mfa.enabled, verified: mfa.verified } }} user={{ displayName: user.displayName, isDemo: user.isDemo }}>
      {children}
    </PlatformShell>
  );
}
