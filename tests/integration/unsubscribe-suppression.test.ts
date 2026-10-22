import { describe, expect, it } from 'vitest';
import { withTenant } from '@/server/db/client';
import { applyUnsubscribe, createUnsubscribeToken } from '@/server/domains/customers/consents';
import { destinationHash } from '@/server/domains/marketing/campaigns';
import { createBusinessFor, signup } from '../helpers/factory';

describe('unsubscribe link ↔ campaign suppression', () => {
  it('an unsubscribe recorded from the signed link is matched by the campaign sender (same normalisation and key)', async () => {
    const owner = await signup('Unsub owner');
    const biz = await createBusinessFor(owner);
    const tc = await withTenant(biz.tenantId, (trx) => trx.insertInto('tenant_customers').values({ tenant_id: biz.tenantId, display_name: 'Walk-in', email: 'Walk.In@Example.test', phone: '+966 50 123 4567', source: 'walk_in' }).returning('id').executeTakeFirstOrThrow());
    for (const ch of ['email', 'sms'] as const) {
      await applyUnsubscribe(createUnsubscribeToken(biz.tenantId, tc.id, ch), { userId: null, kind: 'system' });
    }
    const rows = await withTenant(biz.tenantId, (trx) => trx.selectFrom('suppression_list').select(['channel', 'destination_hash']).execute());
    const hex = (b: Buffer) => b.toString('hex');
    expect(rows.map((r) => hex(r.destination_hash as Buffer)).sort()).toEqual(
      [hex(destinationHash('email', ' walk.in@example.test')), hex(destinationHash('sms', '+966501234567'))].sort(),
    );
  });
});
