import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import '@/server/boot';
import { errorResponse } from '@/server/http/route';
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
    await enforce(`webhook:${provider}:${req.headers.get('x-forwarded-for') ?? 'unknown'}`, 600, 60);
    const raw = await req.text();
    if (raw.length > 256_000) return NextResponse.json({ error: { code: 'payload_too_large' } }, { status: 413 });
    const r = await handleWebhook(provider, raw, req.headers);
    return NextResponse.json({ data: r }, { status: 200, headers: { 'x-request-id': requestId } });
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
