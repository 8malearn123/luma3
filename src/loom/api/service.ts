import type { z } from 'zod';
import { audit, Errors, withSystem, withTenant, type AuditActor } from '../db';
import { ensureConnection, requestAnalysis } from '../analysis/run';
import type { Offering } from '../contracts/canonical';
import { connectorFor } from '../connectors/registry';
import type { DecisionReason } from '../contracts/opportunity';
import { cardDetails, renderCard } from '../opportunities/render';
import { decide, DecisionError, markConverted, type DecisionInput } from '../opportunities/store';
import { loadFacts, loadGoals, replaceGoals, resolveProfile, validateExplicit, writeFact } from '../profile/facts';
import { readPlatformSettings } from '../settings/platform';
import { render, type LoomLocale } from '../util/text';
import { createInitiativeFor, opportunityMemory, resurfacedMap } from './memory';
import type { goalsInput, opportunityListQuery, preferencesInput, setupInput } from './schemas';

/**
 * Loom API v1 service layer (host-agnostic: takes a business id and an
 * actor). Authentication, capability mapping and plan features are enforced
 * by the host routes (src/app/api/v1/t/[tenantSlug]/loom/*).
 */
type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };

const platformWeights = () => withSystem('loom: weights', async (trx) => (await readPlatformSettings(trx)).default_ranking_weights);

/** Active services and products (canonical, through the connector) for the setup pickers. */
async function offeringChoices(businessId: string, locale: LoomLocale) {
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const page = await connectorFor(conn.kind).pull(conn, 'offerings', null, 1000);
  return (page.records.map((r) => r.data) as Offering[]).filter((o) => o.status === 'active' && (o.kind === 'service' || o.kind === 'product'))
    .map((o) => ({ id: o.id, kind: o.kind, name: render(o.name, locale) }));
}

export async function getProfile(c: Pick<Ctx, 'businessId' | 'locale'>) {
  const weights = await platformWeights();
  const offerings = await offeringChoices(c.businessId, c.locale);
  return withTenant(c.businessId, async (trx) => {
    const facts = await loadFacts(trx, c.businessId);
    const goals = await loadGoals(trx, c.businessId);
    const p = resolveProfile(facts, goals, weights);
    return {
      goals: p.goals, preferences: p.prefs, competitor_prices: p.competitor_prices, offerings, platform_weights: weights,
      facts: p.facts.map((f) => ({ key: f.key, value: f.value, kind: f.kind, source: f.source, confidence: f.confidence, needs_review: f.needs_review, updated_at: f.updated_at })),
      setup: { ...p.setup, items: p.setup.items.map((i) => ({ ...i, label: render(i.label, c.locale) })) },
    };
  });
}

export async function patchProfile(c: Ctx, facts: Record<string, unknown>) {
  const parsed: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(facts)) {
    if (k === 'consent.shared_training') throw Errors.forbidden('Use the setup endpoint (owner only) for shared-training consent');
    try { parsed.push([k, validateExplicit(k, v)]); } catch { throw Errors.invalid('invalid_fact', `Invalid value for ${k}`); }
  }
  await withTenant(c.businessId, async (trx) => {
    for (const [key, value] of parsed) await writeFact(trx, c.businessId, { key, value, kind: 'explicit', source_type: 'user', by: c.actor.userId });
    await audit(trx, c.actor, 'loom.profile_updated', { tenantId: c.businessId, data: { keys: parsed.map(([k]) => k) } });
  });
  return getProfile(c);
}

export async function putGoals(c: Ctx, input: z.infer<typeof goalsInput>) {
  await withTenant(c.businessId, async (trx) => {
    await replaceGoals(trx, c.businessId, input.goals, c.actor.userId);
    await audit(trx, c.actor, 'loom.goals_updated', { tenantId: c.businessId, data: { goals: input.goals.map((g) => `${g.priority}:${g.kind}`) } });
  });
  return getProfile(c);
}

const PREF_KEYS: Record<keyof z.infer<typeof preferencesInput>, string> = {
  monthly_budget_minor: 'pref.monthly_budget_minor', no_discounts: 'pref.no_discounts', max_discount_bp: 'pref.max_discount_bp',
  excluded_offerings: 'pref.excluded_offerings', growth_offerings: 'pref.growth_offerings', tone: 'pref.tone', ranking_weights: 'pref.ranking_weights',
};

export async function putPreferences(c: Ctx, input: z.infer<typeof preferencesInput>) {
  return putSetup(c, input as z.infer<typeof setupInput>);
}

/** Confirms setup items. shared_training_consent must be checked for business.manage by the route. */
export async function putSetup(c: Ctx, input: z.infer<typeof setupInput>) {
  const facts: Array<[string, unknown]> = [];
  for (const [k, key] of Object.entries(PREF_KEYS)) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined) facts.push([key, v]);
  }
  if (input.discount_policy) facts.push(['pref.no_discounts', input.discount_policy.no_discounts], ['pref.max_discount_bp', input.discount_policy.no_discounts ? 0 : input.discount_policy.max_discount_bp]);
  if (input.offerings_scope) facts.push(['pref.excluded_offerings', input.offerings_scope.excluded], ['pref.growth_offerings', input.offerings_scope.growth]);
  if (input.shared_training_consent !== undefined) facts.push(['consent.shared_training', input.shared_training_consent]);
  const goals = input.goals;
  await withTenant(c.businessId, async (trx) => {
    if (goals) await replaceGoals(trx, c.businessId, goals.map((g) => ({ ...g, offering_ids: g.offering_ids ?? [], note: g.note ?? null })), c.actor.userId);
    for (const [key, value] of facts) await writeFact(trx, c.businessId, { key, value: validateExplicit(key, value), kind: 'explicit', source_type: 'user', by: c.actor.userId });
    await audit(trx, c.actor, 'loom.setup_confirmed', { tenantId: c.businessId, data: { keys: [...facts.map(([k]) => k), ...(goals ? ['setup.goals'] : [])] } });
  });
  return getProfile(c);
}

export async function getDataQuality(c: Pick<Ctx, 'businessId' | 'locale'>) {
  return withTenant(c.businessId, async (trx) => {
    const q = await trx.selectFrom('loom.data_quality_checks').selectAll().where('business_id', '=', c.businessId).orderBy('created_at', 'desc').executeTakeFirst();
    if (!q) return { status: 'not_analyzed' as const, report: null };
    const domains = q.domains as Record<string, { level: string; reasons: Array<{ ar: string; en: string }>; improve: Array<{ ar: string; en: string }> }>;
    const checks = q.checks as Array<{ id: string; domain: string; level: string; value: number | null; detail: { ar: string; en: string }; improve: { ar: string; en: string } | null }>;
    return {
      status: 'ok' as const,
      report: {
        analysis_id: q.analysis_id, created_at: q.created_at, overall: q.overall,
        domains: Object.fromEntries(Object.entries(domains).map(([k, v]) => [k, { level: v.level, reasons: v.reasons.map((r) => render(r, c.locale)), improve: v.improve.map((r) => render(r, c.locale)) }])),
        checks: checks.map((x) => ({ id: x.id, domain: x.domain, level: x.level, value: x.value, detail: render(x.detail, c.locale), improve: x.improve ? render(x.improve, c.locale) : null })),
      },
    };
  });
}

export async function startAnalysis(c: Ctx) {
  const r = await requestAnalysis(c.businessId, { trigger: 'manual', requestedBy: c.actor.userId });
  await withTenant(c.businessId, (trx) => audit(trx, c.actor, 'loom.analysis_requested', { tenantId: c.businessId, targetType: 'loom_analysis', targetId: r.analysis.id, data: { created: r.created } }));
  return { job_id: r.analysis.id, status: r.analysis.status, created: r.created };
}

const analysisView = (a: { id: string; status: string; trigger: string; mode: string | null; quality_level: string | null; result: unknown; error_code: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null }, locale: LoomLocale) => {
  const r = (a.result ?? {}) as { data_needed?: Array<{ ar: string; en: string }> } & Record<string, unknown>;
  return { id: a.id, status: a.status, trigger: a.trigger, mode: a.mode, quality: a.quality_level, error_code: a.error_code, created_at: a.created_at, started_at: a.started_at, finished_at: a.finished_at,
    result: { ...r, data_needed: (r.data_needed ?? []).map((x) => render(x, locale)) } };
};

export async function listAnalyses(c: Pick<Ctx, 'businessId' | 'locale'>) {
  return withTenant(c.businessId, async (trx) => (await trx.selectFrom('loom.analyses').selectAll().where('business_id', '=', c.businessId).orderBy('created_at', 'desc').limit(20).execute()).map((a) => analysisView(a, c.locale)));
}

export async function getAnalysis(c: Pick<Ctx, 'businessId' | 'locale'>, id: string) {
  const a = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.analyses').selectAll().where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst());
  if (!a) throw Errors.notFound('analysis');
  return analysisView(a, c.locale);
}

const rowView = (o: { id: string; business_id: string; card: unknown; status: string; display_bucket: string | null; evidence_strength: string | null; decision_reason: string | null; decided_at: Date | null; deferred_until: string | null; detector_id: string; conversion: unknown; updated_at: Date }, locale: LoomLocale, resurfaced: { reason: string; at: Date } | null = null) => ({
  // «عادت للظهور لأن القيد زال»: re-offered after a capacity / inventory / budget / timing rejection (§10.1, T13).
  resurfaced,
  card: renderCard(o, locale), details: cardDetails(o, locale), status: o.status, bucket: o.display_bucket, evidence_strength: o.evidence_strength, detector_id: o.detector_id,
  decision: o.decided_at ? { reason: o.decision_reason, at: o.decided_at, deferred_until: o.deferred_until } : null, conversion: o.conversion, updated_at: o.updated_at,
});

export async function listOpportunities(c: Pick<Ctx, 'businessId' | 'locale'>, q: z.infer<typeof opportunityListQuery>) {
  return withTenant(c.businessId, async (trx) => {
    let qb = trx.selectFrom('loom.opportunities').selectAll().where('business_id', '=', c.businessId);
    if (q.status) qb = qb.where('status', '=', q.status);
    else if (q.open !== '0') qb = qb.where('status', 'not in', ['expired', 'superseded', 'closed']);
    if (q.category) qb = qb.where('category', '=', q.category);
    if (q.bucket) qb = qb.where('display_bucket', '=', q.bucket);
    const rows = await qb.orderBy('priority_rank', 'asc').orderBy('updated_at', 'desc').limit(100).execute();
    const back = await resurfacedMap(trx, c.businessId, rows.map((o) => o.id));
    return rows.map((o) => rowView(o, c.locale, back.get(o.id) ?? null));
  });
}

export async function getOpportunity(c: Pick<Ctx, 'businessId' | 'locale'> & { actor?: AuditActor }, id: string) {
  return withTenant(c.businessId, async (trx) => {
    const o = await trx.selectFrom('loom.opportunities').selectAll().where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst();
    if (!o) throw Errors.notFound('opportunity');
    const refs = (o.card as { evidence_refs: string[] }).evidence_refs;
    const evidence = refs.length ? await trx.selectFrom('loom.opportunity_evidence').selectAll().where('business_id', '=', c.businessId).where('id', 'in', refs).execute() : [];
    const checks = await trx.selectFrom('loom.opportunity_checks').select(['check_type', 'status', 'details', 'created_at']).where('business_id', '=', c.businessId).where('opportunity_id', '=', id).orderBy('created_at', 'desc').limit(8).execute();
    const events = await trx.selectFrom('loom.opportunity_events').select(['event', 'from_status', 'to_status', 'reason', 'note', 'counts_as_idea_failure', 'created_at']).where('business_id', '=', c.businessId).where('opportunity_id', '=', id).orderBy('created_at').execute();
    const back = await resurfacedMap(trx, c.businessId, [o.id]);
    return {
      ...rowView(o, c.locale, back.get(o.id) ?? null),
      // Phase 5: decision ladder (each stage), the caller's like/dislike (taste only) and initiatives.
      ...(await opportunityMemory(trx, c.businessId, id, c.actor?.userId ?? null)),
      evidence: evidence.map((e) => ({ id: e.id, metric_key: e.metric_key, grain_ref: e.grain_ref, value: e.value, n: e.n, label: render(e.label as { ar: string; en: string }, c.locale), grade: e.grade })),
      checks: Object.values(Object.fromEntries(checks.reverse().map((x) => [x.check_type, { type: x.check_type, status: x.status, details: x.details }]))),
      events,
    };
  });
}

export async function decideOpportunity(c: Ctx, id: string, input: DecisionInput) {
  try {
    const r = await withTenant(c.businessId, async (trx) => {
      const out = await decide(trx, c.businessId, id, input, c.actor.userId);
      await audit(trx, c.actor, 'loom.opportunity_decided', { tenantId: c.businessId, targetType: 'loom_opportunity', targetId: id, data: { action: input.action, reason: (input as { reason?: DecisionReason }).reason ?? null } });
      return out;
    });
    return getOpportunity(c, r.id);
  } catch (e) {
    if (e instanceof DecisionError) throw e.code === 'not_found' ? Errors.notFound('opportunity') : Errors.conflict('invalid_transition', 'This decision is not possible in the opportunity’s current state');
    throw e;
  }
}

export async function recordConversion(c: Ctx, id: string, conversion: { target: string; ref_id: string }) {
  try {
    await withTenant(c.businessId, async (trx) => {
      await markConverted(trx, c.businessId, id, conversion, c.actor.userId);
      // §10.2: the initiative record (frozen baseline + original proposal) and the `scheduled` stage.
      await createInitiativeFor(trx, c.businessId, id, conversion, c.actor.userId);
      await audit(trx, c.actor, 'loom.opportunity_converted', { tenantId: c.businessId, targetType: 'loom_opportunity', targetId: id, data: conversion });
    });
  } catch (e) {
    if (e instanceof DecisionError) throw e.code === 'not_found' ? Errors.notFound('opportunity') : Errors.conflict('invalid_transition', 'Only proposed or accepted opportunities can be converted');
    throw e;
  }
  return getOpportunity(c, id);
}

export async function listConnections(c: Pick<Ctx, 'businessId'>) {
  const rows = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.connections').selectAll().where('business_id', '=', c.businessId).execute());
  const out = [];
  for (const r of rows) {
    const runs = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.sync_runs').select(['status', 'finished_at', 'entities', 'data_version']).where('connection_id', '=', r.id).orderBy('finished_at', 'desc').limit(1).execute());
    out.push({ id: r.id, kind: r.kind, status: r.status, last_sync_at: r.last_sync_at, last_error: r.last_error, last_run: runs[0] ?? null,
      health: await connectorFor(r.kind).healthcheck({ id: r.id, business_id: c.businessId, kind: r.kind, config: {} }), manifest: connectorFor(r.kind).describe() });
  }
  return out;
}

/**
 * Builds the host command for a conversion from the stored card. Loom never
 * executes it: the host's ActionPort does, with the host's permissions.
 */
export async function conversionCommand(c: Pick<Ctx, 'businessId'>, id: string, input: import('./schemas').ConvertInput): Promise<import('../contracts/actions').ActionCommand> {
  const o = await withTenant(c.businessId, (trx) => trx.selectFrom('loom.opportunities').select(['id', 'status', 'card', 'subject']).where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst());
  if (!o) throw Errors.notFound('opportunity');
  if (!['proposed', 'studying', 'accepted', 'converted'].includes(o.status)) throw Errors.conflict('invalid_transition', 'Only proposed or accepted opportunities can be converted');
  const card = o.card as import('../contracts/opportunity').CardContent;
  const subject = o.subject as { offering_ids: string[] };
  if (input.target === 'plan_action') {
    return { kind: 'plan_action', opportunity_id: id, title: card.title, description: card.recommended_action.description, channel: card.channel[0] ?? null, window: card.period, evidence_refs: card.evidence_refs };
  }
  if (input.target === 'campaign_draft') {
    if (card.category === 'capacity_prerequisite' || ['open_slots', 'staffing', 'restock', 'price_review'].includes(card.recommended_action.kind)) {
      throw Errors.invalid('not_a_campaign', 'This opportunity is an operational step, not a campaign');
    }
    const ch = input.channel ?? (card.channel.find((x) => ['in_app', 'email', 'sms', 'whatsapp'].includes(x)) as 'in_app' | undefined) ?? 'in_app';
    return { kind: 'campaign_draft', opportunity_id: id, name: card.title, body: card.recommended_action.description, channel: ch, segment: (card.target_segment.definition as Record<string, unknown>) ?? null };
  }
  if (card.recommended_action.kind !== 'price_review' || !subject.offering_ids[0]) throw Errors.invalid('not_a_price_review', 'Only price-review opportunities can become a price proposal');
  return { kind: 'price_proposal', opportunity_id: id, offering_id: subject.offering_ids[0], proposed_price_minor: input.proposed_price_minor, reason: `Loom: ${card.title.en}`.slice(0, 500) };
}
