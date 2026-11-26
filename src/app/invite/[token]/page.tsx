import type { Metadata } from 'next';
import { getSessionUser } from '@/server/pages';
import { previewInvitation } from '@/server/domains/team/service';
import { codeDeliveryAvailable } from '@/server/auth/service';
import { InviteAccept } from '@/ui/team/InviteAccept';

// The token is a capability: never index the page or leak it to other sites through Referer.
export const metadata: Metadata = { title: 'Invitation', robots: { index: false, follow: false }, referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

/**
 * /invite/{token} — staff invitation (LUMA-AUDIT-005). Signed out: shows the
 * business, role and masked destination, then sign-in (or registration when a
 * messaging provider can verify the contact) returning here. Signed in: the
 * verified email/phone must match the invitation; accepting uses
 * POST /api/v1/invitations/accept, whose tenant and role come only from the
 * invitation record.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getSessionUser();
  const p = await previewInvitation(token, user);
  const here = `/invite/${encodeURIComponent(token)}`;
  return (
    <InviteAccept
      token={token}
      state={p.state}
      businessName={p.business_name}
      role={p.role}
      destination={p.destination}
      expiresAt={p.expires_at ? p.expires_at.toISOString() : null}
      user={user ? { name: user.displayName, matches: p.matches_user } : null}
      loginHref={`/auth/login?next=${encodeURIComponent(here)}`}
      registerHref={codeDeliveryAvailable() ? `/auth/register?next=${encodeURIComponent(here)}` : null}
    />
  );
}
