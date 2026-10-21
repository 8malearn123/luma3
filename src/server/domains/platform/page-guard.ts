import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { requireUser } from '../../pages';
import { platformCapabilities, type PlatformCapability } from '../../auth/capabilities';
import { platformMfaState } from './guard';

/**
 * Server-component guard for /platform pages: sign-in required; non-platform
 * users get the same 404 as an unknown page; once MFA is enabled the session
 * must be verified (otherwise redirect to /platform/mfa).
 */
export async function requirePlatformPage(opts: { allowUnverified?: boolean } = {}) {
  const path = (await headers()).get('x-pathname') ?? '/platform';
  const user = await requireUser(path);
  const caps = platformCapabilities(user.platformRoles);
  if (caps.size === 0) notFound();
  const mfa = await platformMfaState(user);
  if (mfa.enabled && !mfa.verified && !opts.allowUnverified) redirect(`/platform/mfa?next=${encodeURIComponent(path)}`);
  return { user, caps, mfa };
}

/** Page-level capability check; returns false to render a denied state (nav already hides it). */
export async function platformPageCan(cap: PlatformCapability) {
  const { caps } = await requirePlatformPage();
  return caps.has(cap);
}
