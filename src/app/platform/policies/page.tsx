import { notFound } from 'next/navigation';
import { requireUser } from '@/server/pages';
import { platformCapabilities } from '@/server/auth/capabilities';
import { PlatformPolicies } from '@/ui/policy/PlatformPolicies';
import { StepUpProvider } from '@/ui/policy/StepUp';

export const metadata = { title: 'Policy review' };

/**
 * LUMA platform policy review. Server-side guard: only policy_reviewer /
 * platform_owner (platform.policy.review). Everyone else gets a 404.
 * Renders inside the platform layout owned by the platform workspace.
 */
export default async function PlatformPoliciesPage() {
  const user = await requireUser('/platform/policies');
  if (!platformCapabilities(user.platformRoles).has('platform.policy.review')) notFound();
  return <StepUpProvider><PlatformPolicies isOwner={user.platformRoles.includes('platform_owner')} /></StepUpProvider>;
}
