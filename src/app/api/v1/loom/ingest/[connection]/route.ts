import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import '@/server/boot';
import { ingestWebhook } from '@/loom';
import { errorResponse } from '@/server/http/route';
import { enforce } from '@/server/infra/rate-limit';

/**
 * POST /api/v1/loom/ingest/{connection} — a connected system → Loom. No
 * cookies or CSRF header (server-to-server); authenticity comes from the
 * connection's ingest secret: X-Loom-Signature (HMAC-SHA256 over
 * "<t>.<raw body>", ±5 minutes) and X-Loom-Event-Id (idempotency).
 */
export async function POST(req: NextRequest, seg: { params: Promise<{ connection: string }> }) {
  const requestId = randomUUID();
  try {
    const { connection } = await seg.params;
    await enforce(`loom-ingest:${connection}`, 600, 60);
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > 1_000_000) return NextResponse.json({ error: { code: 'payload_too_large' } }, { status: 413 });
    const r = await ingestWebhook(connection, req);
    return NextResponse.json({ data: r }, { status: r.duplicate ? 200 : 202, headers: { 'x-request-id': requestId } });
  } catch (e) {
    return errorResponse(e, requestId);
  }
}
