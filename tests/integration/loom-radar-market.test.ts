import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow, setRadarFetcher } from '@/loom';
import * as market from '@/app/api/v1/t/[tenantSlug]/loom/market-observations/route';
import * as marketOne from '@/app/api/v1/t/[tenantSlug]/loom/market-observations/[id]/route';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import { lumaRadarFetcher } from '@/server/loom-host/radar';
import { addMember } from '../helpers/platform';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { loomSalon } from '../helpers/loom-core';
import { ok, useFakeRadar } from '../helpers/loom-radar';

afterEach(() => setRadarFetcher(lumaRadarFetcher()));
afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', '=', 'loom.analysis').execute());
});

const today = new Date().toISOString().slice(0, 10);
const obs = (o: Record<string, unknown>) => ({ kind: 'price_point', note: 'Seen on their price list', observed_on: today, comparability: 'comparable', ...o });

describe('Market observations (§12.3)', () => {
  it('owner adds manual and link observations with comparability; a price without our offering is not comparable', async () => {
    const s = await loomSalon();
    useFakeRadar({ 'https://competitor.example.com/prices': () => ok('<html><head><title>Competitor menu</title><meta name="description" content="Colour from 99"></head></html>', 'text/html') });
    const a = await s.owner.call(market.POST, { params: s.p, body: obs({ offering_id: s.s1, competitor: 'Salon X', price_minor: 9900, region: 'الرياض' }) });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ comparability: 'comparable', source_type: 'manual' });
    expect((await s.owner.call(market.POST, { params: s.p, body: obs({ offering_id: s.s1, comparability: 'partial' }) })).status).toBe(422); // reasons required
    expect((await s.owner.call(market.POST, { params: s.p, body: obs({ kind: 'audience_need', price_minor: 100 }) })).status).toBe(422); // price only for prices
    const noOff = await s.owner.call(market.POST, { params: s.p, body: obs({ price_minor: 5000 }) });
    expect(noOff.body.data).toMatchObject({ comparability: 'not_comparable', comparability_reasons: ['no_matching_offering'] });
    const link = await s.owner.call(market.POST, { params: s.p, body: obs({ kind: 'competitor_offer', offering_id: s.s1, price_minor: 12000, source: 'link', source_url: 'https://competitor.example.com/prices', comparability: 'partial', comparability_reasons: ['different_duration'] }) });
    expect(link.status).toBe(201);
    expect(link.body.data).toMatchObject({ link_status: 'fetched', untrusted_title: 'Competitor menu', untrusted_excerpt: 'Colour from 99' });
    const blocked = await s.owner.call(market.POST, { params: s.p, body: obs({ source: 'link', source_url: 'https://x.internal-ip.example/p' }) });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('blocked_url');

    const l = (await s.owner.call(market.GET, { params: s.p })).body.data;
    expect(l.observations).toHaveLength(3);
    expect(l.price_context.find((p: any) => p.offering_id === s.s1)).toMatchObject({ our_price_minor: 20000, comparable_prices: 2, position: 'above_market', may_decrease_price: false });
    const arch = await s.owner.call(marketOne.PATCH, { params: { ...s.p, id: noOff.body.data.id }, body: { archived: true } });
    expect(arch.body.data.archived_at).toBeTruthy();
    expect((await s.owner.call(marketOne.PATCH, { params: { ...s.p, id: noOff.body.data.id }, body: { comparability: 'comparable', comparability_reasons: [] } })).status).toBe(422);
    expect((await s.owner.call(market.GET, { params: s.p })).body.data.observations).toHaveLength(2);
  });

  it('T15: a much lower competitor price never yields a price decrease or a discount justified by it', async () => {
    const s = await loomSalon();
    // Thin margin on S1 → a margin_leak opportunity exists (an INCREASE review).
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('services').set({ cost_minor: 18000 }).where('id', '=', s.s1).execute());
    for (const off of [s.s1, s.s2]) await s.owner.call(market.POST, { params: s.p, body: obs({ offering_id: off, competitor: 'Cheap Salon', price_minor: 5000 }) });
    await analyzeNow(s.biz.tenantId);
    const list = (await s.owner.call(opps.GET, { params: s.p })).body.data as any[];
    expect(list.length).toBeGreaterThan(0);
    for (const o of list) {
      expect(o.details.recommended_action.direction ?? null).not.toBe('decrease');
      if (o.card.recommended_action.kind === 'price_review' && o.details.recommended_action.intervention_id === 'price_review') expect(o.details.recommended_action.direction).toBe('increase_review');
    }
    const onObserved = list.filter((o) => o.card.category !== 'missing_cost_blocker');
    expect(onObserved.some((o) => o.card.limitations.some((x: string) => /سياق فقط|context only/.test(x)))).toBe(true);
    const leak = list.find((o) => o.card.category === 'margin_leak');
    expect(leak).toBeTruthy();
    // A Loom price proposal below the current price is refused; an increase is still possible.
    const down = await s.owner.call(convert.POST, { params: { ...s.p, id: leak.card.opportunity_id }, body: { target: 'price_proposal', proposed_price_minor: 5000 } });
    expect(down.status).toBe(422);
    expect(down.body.error.code).toBe('price_decrease_not_supported');
    expect((await s.owner.call(convert.POST, { params: { ...s.p, id: leak.card.opportunity_id }, body: { target: 'price_proposal', proposed_price_minor: 23000 } })).status).toBe(201);
  });

  it('permissions and tenant isolation', async () => {
    const s = await loomSalon();
    const other = await loomSalon({ name: 'Market Other' });
    const a = await s.owner.call(market.POST, { params: s.p, body: obs({ offering_id: s.s1, price_minor: 15000 }) });
    expect((await other.owner.call(market.GET, { params: other.p })).body.data.observations).toEqual([]);
    expect((await other.owner.call(marketOne.PATCH, { params: { ...other.p, id: a.body.data.id }, body: { archived: true } })).status).toBe(404);
    // Another business's offering cannot be referenced.
    expect((await other.owner.call(market.POST, { params: other.p, body: obs({ offering_id: s.s1, price_minor: 1 }) })).status).toBe(422);
    const receptionist = await addMember(s.owner, s.biz.slug, 'receptionist');
    expect((await receptionist.call(market.GET, { params: s.p })).status).toBe(403);
  });
});
