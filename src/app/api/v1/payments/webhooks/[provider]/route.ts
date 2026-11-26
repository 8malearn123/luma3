import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import '@/server/boot';
import { clientIp, errorResponse } from '@/server/http/route';
import { handleWebhook } from '@/server/domains/payments/service';
import { enforce } from '@/server/infra/rate-limit';

/**
 * POST /api/v1/payments/webhooks/{provider} — provider → LUMA. No cookies or CSRF
 * header (server-to-server); authenticity comes from the provider signature.
 */
export async function POST(req: NextRequest, seg: { params: Promise<{ provider: string }> }) {
  const requestId = randomUUID();
  try {
    const { provider } = await seg.params;
    // Keyed on the trusted client address (the entry our own proxy appended), never on the raw,
    // client-controlled X-Forwarded-For value, which an attacker could vary per request (LUMA-AUDIT-026).
    if (!/^[a-z0-9_-]{1,32}$/.test(provider)) return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
    await enforce(`webhook:${provider}:${clientIp(req) ?? 'unknown'}`, 600, 60);
    const raw = await req.text();
    if (raw.length > 256_000) return NextResponse.json({ error: { code: 'payload_too_large' } }, { status: 413 });
    const r = await handleWebhook(provider, raw, req.headers);
    return NextResponse.json({ data: r }, { status: 200, headers: { 'x-request-id': requestId } });
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
