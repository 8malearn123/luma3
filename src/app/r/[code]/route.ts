import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/server/env';
import { cleanReferralCode, REFERRAL_COOKIE } from '@/server/domains/referrals/service';

/**
 * GET /r/{code} — referral link. Remembers the code for 30 days (first-party,
 * httpOnly cookie read by POST /api/v1/tenants) and sends the visitor to sign
 * up and create a business. Unknown or malformed codes are simply ignored.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const clean = cleanReferralCode(code);
  const next = clean ? `/app/new?ref=${encodeURIComponent(clean)}` : '/app/new';
  const res = NextResponse.redirect(new URL(`/auth/register?next=${encodeURIComponent(next)}`, req.nextUrl.origin));
  if (clean) {
    res.cookies.set(REFERRAL_COOKIE, clean, { httpOnly: true, sameSite: 'lax', secure: env().isDeployed, path: '/', maxAge: 30 * 86_400 });
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
