import { afterAll, describe, expect, it } from 'vitest';
import { withSystem, withTenant } from '@/server/db/client';
import { analyzeNow } from '@/loom';
import * as opps from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/route';
import * as oppOne from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/route';
import * as decision from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/decision/route';
import * as convert from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/convert/route';
import * as feedback from '@/app/api/v1/t/[tenantSlug]/loom/opportunities/[id]/feedback/route';
import * as initiatives from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/route';
import * as initiativeOne from '@/app/api/v1/t/[tenantSlug]/loom/initiatives/[id]/route';
import * as decisions from '@/app/api/v1/t/[tenantSlug]/loom/decisions/route';
import * as profile from '@/app/api/v1/t/[tenantSlug]/loom/profile/route';
import * as setup from '@/app/api/v1/t/[tenantSlug]/loom/setup/route';
import { cancelLeftoverMarketingJobs } from '../helpers/loom';
import { approvedLeave, loomSalon } from '../helpers/loom-core';

afterAll(async () => {
  await cancelLeftoverMarketingJobs();
  await withSystem('test cleanup', (trx) => trx.updateTable('job_runs').set({ status: 'cancelled' }).where('status', '=', 'queued').where('kind', 'like', 'loom.%').execute());
});

type Salon = Awaited<ReturnType<typeof loomSalon>>;
const cards = async (s: Salon, query: Record<string, string> = {}) => (await s.owner.call(opps.GET, { params: s.p, query })).body.data as any[];
const promo = (list: any[]) => list.find((o) => !['open_slots', 'staffing', 'restock', 'price_review'].includes(o.card.recommended_action.kind) && o.status === 'proposed');

describe('Decision ladder (§10.1)', () => {
  it('records viewed / reacted / decided / scheduled as separate append-only stages; reactions are stored apart', async () => {
    const s = await loomSalon({ consents: true });
    await analyzeNow(s.biz.tenantId);
    const o = promo(await cards(s));
    const params = { ...s.p, id: o.card.opportunity_id };
    // viewed: usage only, deduplicated per person.
    expect((await s.owner.call(feedback.POST, { params, body: { kind: 'viewed' } })).body.data.recorded).toBe(true);
    expect((await s.owner.call(feedback.POST, { params, body: { kind: 'viewed' } })).body.data.recorded).toBe(false);
    // reacted: taste.
    await s.owner.call(feedback.POST, { params, body: { kind: 'reaction', reaction: 'like' } });
    const r2 = await s.owner.call(feedback.POST, { params, body: { kind: 'reaction', reaction: 'dislike' } });
    expect(r2.body.data.reaction).toBe('dislike');
    expect((await s.owner.call(feedback.POST, { params, body: { kind: 'reaction', reaction: 'meh' } })).status).toBe(422);
    // decided: edit + approve keeps the edits.
    const edits = { description: 'نسخة معدلة من المالكة', channel: ['in_app'], period: { from: o.card.period.from, to: o.card.period.to } };
    const ap = await s.owner.call(decision.POST, { params, body: { action: 'approve', edits } });
    expect(ap.status).toBe(200);
    expect(ap.body.data.ladder.at(-1)).toMatchObject({ stage: 'decided', action: 'edit_approve', data: { edits } });
    // scheduled: conversion creates the initiative record.
    const cv = await s.owner.call(convert.POST, { params, body: { target: 'plan_action' } });
    expect(cv.status).toBe(201);
    const detail = (await s.owner.call(oppOne.GET, { params })).body.data;
    expect(detail.reaction).toBe('dislike');
    expect(detail.ladder.map((x: any) => x.stage)).toEqual(['viewed', 'reacted', 'reacted', 'decided', 'scheduled']);
    expect(detail.initiatives).toHaveLength(1);

    const list = (await s.owner.call(initiatives.GET, { params: s.p })).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'scheduled', artifact: { kind: 'plan_action', ref: cv.body.data.result.ref_id }, edited: true, measurement: { design: 'pre_post_with_control', quality: null } });
    expect(list[0].action.description).toBe('نسخة معدلة من المالكة');
    const full = (await s.owner.call(initiativeOne.GET, { params: { ...s.p, id: list[0].id } })).body.data;
    expect(full.user_edits.map((d: any) => d.path).sort()).toEqual(['channel', 'period', 'recommended_action.description']);
    expect(full.original_proposal.action).toBe(o.card.recommended_action.description);
    expect(full.baseline.metrics.length).toBeGreaterThan(0);
    expect(full.baseline.data_version).toBeTruthy();

    // Reactions are taste: they live in loom.feedback and never in outcomes.
    const fb = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.feedback').select('reaction').execute());
    expect(fb.map((x) => x.reaction).sort()).toEqual(['dislike', 'like']);
    // Append-only.
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.decision_history').set({ note: 'x' }).execute())).rejects.toThrow();
    await expect(withTenant(s.biz.tenantId, (trx) => trx.deleteFrom('loom.decision_history').execute())).rejects.toThrow();
    await expect(withTenant(s.biz.tenantId, (trx) => trx.deleteFrom('loom.feedback').execute())).rejects.toThrow();
    const all = (await s.owner.call(decisions.GET, { params: s.p })).body.data;
    expect(all.length).toBe(5);
  });

  it('initiative baseline and original proposal are frozen; initiatives are never deleted', async () => {
    const s = await loomSalon();
    await analyzeNow(s.biz.tenantId);
    const o = promo(await cards(s));
    await s.owner.call(convert.POST, { params: { ...s.p, id: o.card.opportunity_id }, body: { target: 'plan_action' } });
    const again = await s.owner.call(convert.POST, { params: { ...s.p, id: o.card.opportunity_id }, body: { target: 'plan_action' } });
    expect(again.status).toBe(201);
    const rows = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.initiatives').select(['id', 'baseline']).execute());
    expect(rows).toHaveLength(1); // same plan ⇒ same initiative (idempotent)
    const id = rows[0]!.id;
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.initiatives').set({ baseline: JSON.stringify({ tampered: true }) }).where('id', '=', id).execute())).rejects.toThrow(/frozen/);
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.initiatives').set({ original_proposal: JSON.stringify({}) }).where('id', '=', id).execute())).rejects.toThrow(/frozen/);
    await expect(withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.initiatives').set({ baseline_data_version: 'x' }).where('id', '=', id).execute())).rejects.toThrow(/frozen/);
    await expect(withTenant(s.biz.tenantId, (trx) => trx.deleteFrom('loom.initiatives').where('id', '=', id).execute())).rejects.toThrow();
    // Mutable parts still move.
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('loom.initiatives').set({ status: 'executing' }).where('id', '=', id).execute());
    const after = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.initiatives').select(['status', 'baseline']).where('id', '=', id).executeTakeFirstOrThrow());
    expect(after.status).toBe('executing');
    expect(after.baseline).toEqual(rows[0]!.baseline);
  });

  it('brand_fit creates an inferred fact that needs the owner’s confirmation before it changes anything', async () => {
    const s = await loomSalon({ consents: true });
    await analyzeNow(s.biz.tenantId);
    const o = promo(await cards(s));
    const intervention = o.details.recommended_action.intervention_id;
    const dm = await s.owner.call(decision.POST, { params: { ...s.p, id: o.card.opportunity_id }, body: { action: 'dismiss', reason: 'brand_fit' } });
    expect(dm.body.data.ladder.at(-1)).toMatchObject({ stage: 'decided', reason: 'brand_fit', counts_as_idea_failure: true });
    let p = (await s.owner.call(profile.GET, { params: s.p })).body.data;
    const fact = p.facts.find((f: any) => f.key === `brand.avoid_intervention:${intervention}`);
    expect(fact).toMatchObject({ kind: 'inferred', needs_review: true });
    expect(p.preferences.avoided_interventions).toEqual([]);
    // The owner confirms → the intervention is excluded from later selections.
    const ok = await s.owner.call(profile.PATCH, { method: 'PATCH', params: s.p, body: { facts: { [`brand.avoid_intervention:${intervention}`]: true } } });
    expect(ok.status).toBe(200);
    p = ok.body.data;
    expect(p.preferences.avoided_interventions).toEqual([intervention]);
    await analyzeNow(s.biz.tenantId);
    for (const c of (await cards(s)).filter((x) => x.status === 'proposed')) expect(c.details.recommended_action.intervention_id).not.toBe(intervention);
  });
});

describe('T13 and resurfacing when the constraint clears', () => {
  it('capacity_staffing: not an idea failure in the ladder; resurfaces with «عادت للظهور لأن القيد زال»', async () => {
    const s = await loomSalon({ s2Staff: 'B' });
    const leave = await approvedLeave(s.biz, s.B!);
    await analyzeNow(s.biz.tenantId);
    const blocked = (await cards(s)).find((o) => o.detector_id === 'high_satisfaction_low_demand');
    const params = { ...s.p, id: blocked.card.opportunity_id };
    const dm = await s.owner.call(decision.POST, { params, body: { action: 'dismiss', reason: 'capacity_staffing' } });
    expect(dm.body.data.ladder.at(-1)).toMatchObject({ stage: 'decided', action: 'dismiss', reason: 'capacity_staffing', counts_as_idea_failure: false });
    // No ladder row for this opportunity counts as an idea failure.
    const failures = await withTenant(s.biz.tenantId, (trx) => trx.selectFrom('loom.decision_history').select('id').where('opportunity_id', '=', blocked.card.opportunity_id).where('counts_as_idea_failure', '=', true).execute());
    expect(failures).toEqual([]);
    await withTenant(s.biz.tenantId, (trx) => trx.updateTable('leave_requests').set({ status: 'cancelled' }).where('id', '=', leave).execute());
    await analyzeNow(s.biz.tenantId);
    const back = (await cards(s)).find((o) => o.card.opportunity_id === blocked.card.opportunity_id);
    expect(back.status).toBe('proposed');
    expect(back.resurfaced).toMatchObject({ reason: 'capacity_available' });
  });

  it('budget: a dismissal resurfaces once the budget preference changes after the decision', async () => {
    const s = await loomSalon({ consents: true });
    await analyzeNow(s.biz.tenantId);
    const o = promo(await cards(s));
    await s.owner.call(decision.POST, { params: { ...s.p, id: o.card.opportunity_id }, body: { action: 'dismiss', reason: 'budget' } });
    await analyzeNow(s.biz.tenantId);
    expect((await cards(s, { open: '0' })).find((x) => x.card.opportunity_id === o.card.opportunity_id).status).toBe('dismissed');
    await s.owner.call(setup.PUT, { method: 'PUT', params: s.p, body: { monthly_budget_minor: 500000 } });
    await analyzeNow(s.biz.tenantId);
    const back = (await cards(s)).find((x) => x.card.opportunity_id === o.card.opportunity_id);
    expect(back).toMatchObject({ status: 'proposed', resurfaced: { reason: 'budget_available' } });
  });
});
