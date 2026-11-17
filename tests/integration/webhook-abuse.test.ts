import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { withSystem } from '@/server/db/client';
import { resetKey } from '@/server/infra/rate-limit';
import * as webhook from '@/app/api/v1/payments/webhooks/[provider]/route';

/**
 * LUMA-AUDIT-026: the webhook rate limit is keyed on the trusted client
 * address (rotating a spoofed X-Forwarded-For prefix does not escape it), and
 * forged/invalid deliveries no longer insert one row each.
 */
async function post(body: string, xff: string) {
  const req = new NextRequest('http://localhost:3000/api/v1/payments/webhooks/sandbox', {
    method: 'POST', body, headers: { 'x-sandbox-signature': 't=1,v1=00', 'x-forwarded-for': xff },
  });
  return (await webhook.POST(req, { params: Promise.resolve({ provider: 'sandbox' }) })).status;
}

const rejectedRows = () => withSystem('test: count rejected webhooks', (trx) => trx.selectFrom('provider_events')
  .select(['provider_event_id', 'payload']).where('provider', '=', 'sandbox').where('signature_valid', '=', false).execute());

describe('payment webhook abuse protection', () => {
  it('a spoofed X-Forwarded-For prefix shares the real client bucket; forged events aggregate into one row', async () => {
    const realIp = '203.0.113.77';
    await resetKey(`webhook:sandbox:${realIp}`);
    const before = (await rejectedRows()).length;
    const statuses: number[] = [];
    // 605 forged deliveries, each claiming a different origin in the client-controlled part of the header.
    for (let i = 0; i < 605; i++) statuses.push(await post(`{"forged":${i}}`, `198.51.${i % 250}.${i % 200}, ${realIp}`));
    expect(statuses.filter((s) => s === 400)).toHaveLength(600);
    expect(statuses.slice(600)).toEqual([429, 429, 429, 429, 429]); // before the fix every request had its own bucket
    const rows = await rejectedRows();
    expect(rows.length - before).toBeLessThanOrEqual(2); // one per 10-minute window (two if the window turned)
    const total = rows.reduce((n, r) => n + Number((r.payload as { count?: number }).count ?? 1), 0);
    expect(total).toBeGreaterThanOrEqual(600); // still audited: how many, when, largest size
  }, 120_000);

  it('rejects implausible provider names before touching storage', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/payments/webhooks/x', { method: 'POST', body: '{}' });
    expect((await webhook.POST(req, { params: Promise.resolve({ provider: '../../etc' }) })).status).toBe(404);
  });
});
