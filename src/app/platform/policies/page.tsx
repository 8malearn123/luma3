import { notFound } from 'next/navigation';
import { requirePlatformPage } from '@/server/domains/platform/page-guard';
import { PlatformPolicies } from '@/ui/policy/PlatformPolicies';
import { StepUpProvider } from '@/ui/policy/StepUp';

export const metadata = { title: 'Policy review' };

/**
 * LUMA platform policy review. Server-side guard (not only the layout's):
 * sign-in, platform role, verified second factor; only policy_reviewer /
 * platform_owner (platform.policy.review). Everyone else gets a 404.
 */
export default async function PlatformPoliciesPage() {
  const { user, caps } = await requirePlatformPage();
  if (!caps.has('platform.policy.review')) notFound();
  return <StepUpProvider><PlatformPolicies isOwner={user.platformRoles.includes('platform_owner')} /></StepUpProvider>;
}
