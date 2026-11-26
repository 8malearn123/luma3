import { audit, Errors, withTenant, type AuditActor, type Tx } from '../db';
import type { ActionCommand } from '../contracts/actions';
import type { CardContent } from '../contracts/opportunity';
import type { AssessedOpportunity } from '../opportunities/engine';
import { sectorPack } from '../sector/beauty';
import { L, type Localized } from '../util/text';
import { addDays } from '../util/time';
import { AWARENESS_FRAMING, checkAwarenessRule } from './awareness';
import { adoptedEvents, eventTitle, relevantPlatformEvents, verificationOf } from './calendar';
import { ATTACHABLE_STATUSES, businessContext } from './context';
import { eventRelevance, isTimeable } from './relevance';
import { isAwarenessOnly } from './topics';
import type { Relevance, TimingContext, TimingEventRef, TimingSignalRef } from './types';

/**
 * P1 attachment rule. An event or a signal cluster can only be ATTACHED to an
 * EXISTING internal opportunity (open, studying, accepted or deferred); it
 * sets timing and message only and never creates an opportunity, a plan item
 * or a campaign by itself (T8). Refused:
 *   - a cluster that is not live (stale, T7) or was dismissed;
 *   - a platform event whose date still needs verification;
 *   - an awareness-only event on a discount opportunity (direct coupling).
 */
type Ctx = { businessId: string; actor: AuditActor };
export type AttachRef = { kind: 'signal_cluster' | 'platform_event' | 'owner_event'; id: string };

async function loadOpportunity(trx: Tx, businessId: string, id: string) {
  const o = await trx.selectFrom('loom.opportunities').select(['id', 'status', 'card', 'category']).where('business_id', '=', businessId).where('id', '=', id).executeTakeFirst();
  if (!o) throw Errors.notFound('opportunity');
  if (!(ATTACHABLE_STATUSES as readonly string[]).includes(o.status)) throw Errors.conflict('opportunity_not_open', 'External items can only be attached to an open internal opportunity');
  return { ...o, card: o.card as CardContent };
}

export async function attachTiming(c: Ctx, ref: AttachRef, opportunityId: string, today = new Date().toISOString().slice(0, 10)) {
  const { rc, ownerEvents } = await businessContext(c.businessId);
  const pack = sectorPack(rc.packId);
  return withTenant(c.businessId, async (trx) => {
    const opp = await loadOpportunity(trx, c.businessId, opportunityId);
    let framing: 'standard' | 'awareness_only' = 'standard';
    if (ref.kind === 'signal_cluster') {
      const cl = await trx.selectFrom('loom.signal_clusters').selectAll().where('business_id', '=', c.businessId).where('id', '=', ref.id).forUpdate().executeTakeFirst();
      if (!cl) throw Errors.notFound('cluster');
      if (cl.status === 'dismissed') throw Errors.conflict('cluster_dismissed', 'Reopen the signal first');
      if (cl.liveness !== 'live' || (cl.valid_until && cl.valid_until < today)) throw Errors.conflict('signal_stale', 'A stale signal cannot set timing');
      await trx.updateTable('loom.signal_clusters').set({ status: 'attached', opportunity_id: opp.id, decided_by: c.actor.userId, decided_at: new Date() }).where('id', '=', cl.id).execute();
      await trx.updateTable('loom.timing_attachments').set({ detached_at: new Date(), detached_by: c.actor.userId })
        .where('business_id', '=', c.businessId).where('ref_kind', '=', 'signal_cluster').where('ref_id', '=', cl.id).where('detached_at', 'is', null).execute();
    } else if (ref.kind === 'platform_event') {
      const ev = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('id', '=', ref.id).executeTakeFirst();
      if (!ev || ev.status !== 'active' || ev.ends_on < today) throw Errors.notFound('calendar_event');
      if (ev.needs_verification) throw Errors.conflict('needs_verification', 'This date is not verified yet; it cannot set timing');
      if (isAwarenessOnly(ev, pack)) framing = 'awareness_only';
    } else {
      const ev = ownerEvents.find((e) => e.id === ref.id);
      if (!ev || ev.ends_on < today) throw Errors.notFound('calendar_event');
    }
    if (framing === 'awareness_only') {
      const chk = checkAwarenessRule({ awareness_only: true, text: [opp.card.title, opp.card.recommended_action.description], discount_bp: opp.card.recommended_action.discount_bp ?? null, action_kind: opp.card.recommended_action.kind }, pack);
      if (chk.violations.includes('discount_coupling')) throw Errors.conflict('awareness_discount_coupling', 'An awareness-only event cannot be tied to a discount');
    }
    const row = await trx.insertInto('loom.timing_attachments').values({ business_id: c.businessId, opportunity_id: opp.id, ref_kind: ref.kind, ref_id: ref.id, framing, attached_by: c.actor.userId })
      .onConflict((oc) => oc.columns(['business_id', 'opportunity_id', 'ref_kind', 'ref_id']).where('detached_at', 'is', null).doNothing()).returningAll().executeTakeFirst();
    await audit(trx, c.actor, 'loom.timing_attached', { tenantId: c.businessId, targetType: 'loom_opportunity', targetId: opp.id, data: { ref_kind: ref.kind, ref_id: ref.id, framing } });
    return { attached: true, opportunity_id: opp.id, ref, framing, id: row?.id ?? null };
  });
}

export async function detachTiming(c: Ctx, ref: AttachRef) {
  return withTenant(c.businessId, async (trx) => {
    await trx.updateTable('loom.timing_attachments').set({ detached_at: new Date(), detached_by: c.actor.userId })
      .where('business_id', '=', c.businessId).where('ref_kind', '=', ref.kind).where('ref_id', '=', ref.id).where('detached_at', 'is', null).execute();
    if (ref.kind === 'signal_cluster') await trx.updateTable('loom.signal_clusters').set({ status: 'open', opportunity_id: null, decided_by: c.actor.userId, decided_at: new Date() }).where('business_id', '=', c.businessId).where('id', '=', ref.id).execute();
    await audit(trx, c.actor, 'loom.timing_detached', { tenantId: c.businessId, data: { ref_kind: ref.kind, ref_id: ref.id } });
    return { attached: false, ref };
  });
}

export async function decideCluster(c: Ctx, id: string, action: 'dismiss' | 'reopen') {
  return withTenant(c.businessId, async (trx) => {
    const cl = await trx.selectFrom('loom.signal_clusters').select(['id', 'status']).where('business_id', '=', c.businessId).where('id', '=', id).executeTakeFirst();
    if (!cl || cl.status === 'merged') throw Errors.notFound('cluster');
    if (action === 'dismiss') {
      await trx.updateTable('loom.timing_attachments').set({ detached_at: new Date(), detached_by: c.actor.userId }).where('business_id', '=', c.businessId).where('ref_kind', '=', 'signal_cluster').where('ref_id', '=', id).where('detached_at', 'is', null).execute();
    }
    await trx.updateTable('loom.signal_clusters').set({ status: action === 'dismiss' ? 'dismissed' : 'open', opportunity_id: null, decided_by: c.actor.userId, decided_at: new Date() }).where('id', '=', id).execute();
    await audit(trx, c.actor, `loom.signal_${action === 'dismiss' ? 'dismissed' : 'reopened'}`, { tenantId: c.businessId, targetType: 'loom_signal_cluster', targetId: id });
    return { id, status: action === 'dismiss' ? 'dismissed' : 'open' };
  });
}

/**
 * timingContextFor — the contract for the planner (phase 3).
 *
 * Input: a business id and an opportunity (its id, or { id, period }).
 * Output (TimingContext): every calendar event in the opportunity window
 * (period.from … period.to + 30 days) that is relevant to the business —
 * owner-verified events, adopted platform events and explicitly attached
 * ones; hidden events are excluded — with verification, framing and
 * relevance, plus the live signal clusters attached to it. Fixed rules:
 * no standalone campaign, unverified dates are not usable, competitor
 * prices never justify a decrease, awareness-only refs listed. Read-only.
 */
export async function timingContextFor(businessId: string, opportunity: string | { id: string; period?: { from: string; to: string } }, opts: { now?: Date } = {}): Promise<TimingContext> {
  const oppId = typeof opportunity === 'string' ? opportunity : opportunity.id;
  const { rc, ownerEvents } = await businessContext(businessId);
  const pack = sectorPack(rc.packId);
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  return withTenant(businessId, async (trx) => {
    const o = await trx.selectFrom('loom.opportunities').select(['id', 'card', 'status']).where('business_id', '=', businessId).where('id', '=', oppId).executeTakeFirst();
    if (!o) throw Errors.notFound('opportunity');
    const card = o.card as CardContent;
    const window = (typeof opportunity !== 'string' && opportunity.period) || card.period;
    const from = window.from < today ? today : window.from;
    const to = addDays(window.to, 30);
    const att = await trx.selectFrom('loom.timing_attachments').selectAll().where('business_id', '=', businessId).where('opportunity_id', '=', oppId).where('detached_at', 'is', null).execute();
    const isAtt = (kind: string, id: string) => att.some((a) => a.ref_kind === kind && a.ref_id === id);
    const choices = await trx.selectFrom('loom.calendar_choices').select(['event_id', 'choice']).where('business_id', '=', businessId).execute();
    const platform = (await relevantPlatformEvents(trx, from, to, rc.city)).filter((e) => isAtt('platform_event', e.id) || choices.some((c) => c.event_id === e.id && c.choice === 'adopted'));
    const relOf = (e: { kind: string; region: string | null; starts_on: string; topics: string[]; awareness_only: boolean }): Relevance => eventRelevance(e, rc);
    const events: TimingEventRef[] = [
      ...ownerEvents.filter((e) => e.ends_on >= from && e.starts_on <= to).map((e): TimingEventRef => ({
        ref: `owner:${e.id}`, origin: 'owner_calendar', title: L(e.title, e.title), title_is_untrusted: false, kind: e.kind, region: null, starts_on: e.starts_on, ends_on: e.ends_on,
        verification: 'verified', usable_for_dates: true, framing: 'standard', attached: isAtt('owner_event', e.id), source: { name: 'owner', url: null },
        relevance: relOf({ kind: e.kind, region: null, starts_on: e.starts_on, topics: [], awareness_only: false }),
      })),
      ...platform.map((e): TimingEventRef => {
        const aw = isAwarenessOnly(e, pack);
        const t = eventTitle(e);
        return {
          ref: `platform:${e.id}`, origin: 'platform_calendar', title: t.title, title_is_untrusted: t.untrusted, kind: e.kind, region: e.region, starts_on: e.starts_on, ends_on: e.ends_on,
          verification: verificationOf(e), usable_for_dates: !e.needs_verification, framing: aw ? 'awareness_only' : 'standard', attached: isAtt('platform_event', e.id),
          source: { name: e.source_name, url: e.source_url }, relevance: relOf({ kind: e.kind, region: e.region, starts_on: e.starts_on, topics: e.topics, awareness_only: aw }),
        };
      }),
    ].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.ref.localeCompare(b.ref));
    const clusterIds = att.filter((a) => a.ref_kind === 'signal_cluster').map((a) => a.ref_id);
    const clusters = clusterIds.length ? await trx.selectFrom('loom.signal_clusters').selectAll().where('business_id', '=', businessId).where('id', 'in', clusterIds).where('liveness', '=', 'live').execute() : [];
    const srcRows = clusters.length ? await trx.selectFrom('loom.signals as s').innerJoin('loom.signal_sources as src', 'src.id', 's.source_id').select(['s.id', 'src.name'])
      .where('s.business_id', '=', businessId).where('s.id', 'in', clusters.flatMap((c) => c.signal_ids)).execute() : [];
    const signals: TimingSignalRef[] = clusters.filter((c) => !c.valid_until || c.valid_until >= today).map((c) => ({
      cluster_id: c.id, untrusted_label: c.untrusted_label, topic: c.topic, evidence_class: c.evidence_class as TimingSignalRef['evidence_class'], valid_until: c.valid_until, attached: true,
      sources: [...new Set(srcRows.filter((s) => c.signal_ids.includes(s.id)).map((s) => s.name))],
    }));
    const notes: Localized[] = [L('المناسبات والإشارات تحدد التوقيت والرسالة فقط لهذه الفرصة الداخلية، ولا تنشئ حملة مستقلة.', 'Events and signals only set the timing and message of this internal opportunity; they never create a standalone campaign.')];
    if (events.some((e) => !e.usable_for_dates)) notes.push(L('بعض التواريخ تحتاج تحققًا ولا تُستخدم كتاريخ مؤكد.', 'Some dates need verification and are not used as confirmed dates.'));
    if (events.some((e) => e.framing === 'awareness_only')) notes.push(AWARENESS_FRAMING);
    return {
      opportunity_id: oppId, window: { from: window.from, to: window.to }, events, signals,
      rules: { standalone_campaign_allowed: false, unverified_dates_usable: false, competitor_price_decrease_allowed: false, awareness_only_refs: events.filter((e) => e.framing === 'awareness_only').map((e) => e.ref) },
      notes,
    };
  });
}

/**
 * Engine post-step (run.ts): explicit attachments win; otherwise the first
 * ADOPTED, VERIFIED platform event within 45 days that falls ≤ 30 days after
 * the opportunity window times a promotional opportunity (same rule as the
 * owner-calendar rule in attachSeasonalTiming). Awareness-only events never
 * time a discount and add the awareness framing. Never creates opportunities.
 */
export async function applyRadarTiming(trx: Tx, businessId: string, opps: AssessedOpportunity[], today: string, packId: string) {
  const pack = sectorPack(packId);
  const horizon = addDays(today, 45);
  const adopted = (await adoptedEvents(trx, businessId, today, horizon, packId)).filter((e) => e.verified && e.starts_on >= today);
  const explicit = await trx.selectFrom('loom.timing_attachments as a').innerJoin('loom.opportunities as o', (j) => j.onRef('o.id', '=', 'a.opportunity_id').onRef('o.business_id', '=', 'a.business_id'))
    .select(['o.fingerprint', 'a.ref_kind', 'a.ref_id', 'a.framing']).where('a.business_id', '=', businessId).where('a.detached_at', 'is', null).where('a.ref_kind', '=', 'platform_event').execute();
  const evIds = explicit.map((x) => x.ref_id);
  const explicitEvents = evIds.length ? await trx.selectFrom('loom.platform_calendar_events').selectAll().where('id', 'in', evIds).where('status', '=', 'active').where('needs_verification', '=', false).execute() : [];
  for (const o of opps) {
    const ex = explicit.find((x) => x.fingerprint === o.fingerprint);
    const exEv = ex ? explicitEvents.find((e) => e.id === ex.ref_id) : undefined;
    if (exEv) { setTiming(o, eventTitle(exEv).title.ar, eventTitle(exEv).title.en, exEv.starts_on, `platform:${exEv.id}`, isAwarenessOnly(exEv, pack)); continue; }
    if (o.card.timing.event_ref || !isTimeable({ category: o.category, action_kind: o.card.recommended_action.kind })) continue;
    const ev = adopted.find((e) => e.starts_on <= addDays(o.card.period.to, 30) && !(e.awareness_only && (o.card.recommended_action.discount_bp ?? 0) > 0));
    if (ev) setTiming(o, ev.title, ev.title, ev.starts_on, `platform:${ev.id}`, ev.awareness_only);
  }
}

function setTiming(o: AssessedOpportunity, ar: string, en: string, starts: string, ref: string, awareness: boolean) {
  const base = o.card.timing.window;
  o.card.timing = {
    window: L(`${base.ar.split(' — ')[0]} — قبل «${ar}» (${starts})${awareness ? ' — توعوي فقط' : ''}`, `${base.en.split(' — ')[0]} — ahead of “${en}” (${starts})${awareness ? ' — awareness only' : ''}`),
    event_ref: awareness ? `${ref}:awareness_only` : ref,
  };
  if (awareness && !o.card.assumptions.some((a) => a.en === AWARENESS_FRAMING.en)) o.card.assumptions.push(AWARENESS_FRAMING);
}

/** Plan command for an attached item (executed by the host ActionPort; never runs by itself). */
export async function timingPlanCommand(businessId: string, ref: AttachRef): Promise<{ command: ActionCommand; opportunity_id: string }> {
  return withTenant(businessId, async (trx) => {
    const a = await trx.selectFrom('loom.timing_attachments').select(['opportunity_id', 'framing']).where('business_id', '=', businessId).where('ref_kind', '=', ref.kind).where('ref_id', '=', ref.id).where('detached_at', 'is', null).orderBy('created_at', 'desc').executeTakeFirst();
    if (!a) throw Errors.conflict('not_attached', 'Attach it to an internal opportunity first');
    const opp = await loadOpportunity(trx, businessId, a.opportunity_id);
    let label: Localized = L('', '');
    if (ref.kind === 'signal_cluster') {
      const cl = await trx.selectFrom('loom.signal_clusters').select(['untrusted_label', 'liveness']).where('id', '=', ref.id).executeTakeFirstOrThrow();
      if (cl.liveness !== 'live') throw Errors.conflict('signal_stale', 'A stale signal cannot set timing');
      label = L(`إشارة خارجية (غير موثقة): ${cl.untrusted_label}`, `External signal (unverified): ${cl.untrusted_label}`);
    } else if (ref.kind === 'platform_event') {
      const e = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('id', '=', ref.id).executeTakeFirstOrThrow();
      const t = eventTitle(e).title;
      label = L(`المناسبة: ${t.ar} (${e.starts_on})`, `Occasion: ${t.en} (${e.starts_on})`);
    }
    const aw = a.framing === 'awareness_only';
    const description = L(`${opp.card.recommended_action.description.ar}\nالتوقيت: ${label.ar}${aw ? `\n${AWARENESS_FRAMING.ar}` : ''}`, `${opp.card.recommended_action.description.en}\nTiming: ${label.en}${aw ? `\n${AWARENESS_FRAMING.en}` : ''}`);
    return { opportunity_id: opp.id, command: { kind: 'plan_action', opportunity_id: opp.id, title: opp.card.title, description, channel: opp.card.channel[0] ?? null, window: opp.card.period, evidence_refs: opp.card.evidence_refs } };
  });
}

export async function recordTimingPlan(c: Ctx, ref: AttachRef, planRef: string) {
  return withTenant(c.businessId, async (trx) => {
    await trx.updateTable('loom.timing_attachments').set({ plan_ref: planRef }).where('business_id', '=', c.businessId).where('ref_kind', '=', ref.kind).where('ref_id', '=', ref.id).where('detached_at', 'is', null).execute();
    if (ref.kind === 'signal_cluster') await trx.updateTable('loom.signal_clusters').set({ planned_ref: planRef }).where('business_id', '=', c.businessId).where('id', '=', ref.id).execute();
    await audit(trx, c.actor, 'loom.timing_added_to_plan', { tenantId: c.businessId, data: { ref_kind: ref.kind, ref_id: ref.id, plan_ref: planRef } });
  });
}
