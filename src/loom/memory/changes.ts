import { schedule, sql, withSystem, withTenant, type Tx } from '../db';
import { checkCapacity, checkInventory, checkMargin, type CapacityResult, type InventoryResult, type MarginResult } from '../checks';
import { connectorFor } from '../connectors/registry';
import type { CanonicalDataset } from '../contracts/canonical';
import type { CardContent } from '../contracts/opportunity';
import { planRevisionPort, type PlanRevisionChange, type PlanRevisionPort, type PlanRevisionReason } from '../contracts/plan-revision';
import { loadDataset } from '../dataset';
import { MetricContext } from '../metrics/context';
import { ensureConnection } from '../analysis/run';
import { recordEvent, reservedVolumes } from '../opportunities/store';
import { readPlatformSettings } from '../settings/platform';
import { writeFact } from '../profile/facts';
import { L, round, type Localized } from '../util/text';
import { addDays, localToMs } from '../util/time';

/**
 * Change aggregator (§13). Host events (stock movements, bookings, approved
 * leave, cost/price changes, measured campaign results) become change
 * signals keyed (business, type, scope):
 *  - an event below its threshold is dropped (when the event carries enough
 *    to decide; otherwise the threshold is evaluated at processing time);
 *  - repeated events aggregate into the ONE pending signal of the key;
 *  - a signal is processed once its debounce window (the cool-down) has
 *    elapsed, and events for the same key during the cool-down after
 *    processing are counted as suppressed, never as a new signal.
 * Processing re-runs ONLY the affected checks (inventory / capacity / margin)
 * on the affected opportunities — no analysis, no LLM — and, when an APPROVED
 * plan contains an affected initiative, asks the host's PlanRevisionPort for
 * a proposed revision version with the reason (the approved one never changes, T10).
 */
/** Outbox topic the host enqueues change events on (handled in src/loom/jobs.ts). */
export const CHANGE_TOPIC = 'loom.change';

export const CHANGE_TYPES = ['inventory', 'occupancy', 'capacity', 'margin', 'campaign_result'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export const CHANGE_RULES: Record<ChangeType, { threshold: number; cooldown_min: number; label: Localized }> = {
  inventory: { threshold: 0, cooldown_min: 30, label: L('مادة تحت حد إعادة الطلب أو نفدت', 'A material fell below its reorder level or ran out') },
  occupancy: { threshold: 0.9, cooldown_min: 30, label: L('امتلاء نافذة مبادرة (إشغال أكبر من ٩٠٪)', 'An initiative window is full (occupancy above 90%)') },
  capacity: { threshold: 0.2, cooldown_min: 30, label: L('إجازة معتمدة تقلّص الطاقة أكثر من ٢٠٪', 'Approved leave shrinks capacity by more than 20%') },
  margin: { threshold: 0.1, cooldown_min: 30, label: L('تغيّر التكلفة أو السعر يغيّر الهامش أكثر من ١٠٪', 'A cost or price change moves the margin by more than 10%') },
  campaign_result: { threshold: 0, cooldown_min: 0, label: L('اكتمل قياس نتيجة حملة', 'A campaign result was measured') },
};

export type ChangeInput =
  | { type: 'inventory'; scope: `item:${string}`; data: { available: number; reorder_level: number | null } }
  | { type: 'occupancy'; scope: `offering:${string}`; data: { booking_ref?: string; starts_at?: string } }
  | { type: 'capacity'; scope: `staff:${string}`; data: { from: string; to: string } }
  | { type: 'margin'; scope: `offering:${string}`; data: { price_before: number; price_after: number; cost_before: number | null; cost_after: number | null } }
  | { type: 'campaign_result'; scope: `initiative:${string}`; data: { campaign_id: string; quality: string } };

/** Threshold of an event that carries its own measurements; null = evaluated at processing time. */
export function eventThreshold(c: ChangeInput): { pass: boolean; magnitude: number | null; threshold: number | null } | null {
  if (c.type === 'inventory') {
    const lvl = c.data.reorder_level ?? 0;
    return { pass: c.data.available <= 0 || c.data.available <= lvl, magnitude: c.data.available, threshold: lvl };
  }
  if (c.type === 'margin') {
    const mb = c.data.price_before - (c.data.cost_before ?? 0), ma = c.data.price_after - (c.data.cost_after ?? 0);
    const shift = round(Math.abs(ma - mb) / Math.max(Math.abs(mb), 1));
    return { pass: shift > CHANGE_RULES.margin.threshold, magnitude: shift, threshold: CHANGE_RULES.margin.threshold };
  }
  return null;
}

/** True when the business uses Loom (has a connection); hosts skip change events otherwise. */
export async function loomEngaged(trx: Tx, businessId: string) {
  return !!(await trx.selectFrom('loom.connections').select('id').where('business_id', '=', businessId).executeTakeFirst());
}

export type RecordResult = 'below_threshold' | 'not_engaged' | 'aggregated' | 'cooling_down' | 'created';

/** Records one host event as a change signal (idempotent aggregation per key). */
export async function recordChange(trx: Tx, businessId: string, c: ChangeInput, opts: { now?: Date } = {}): Promise<RecordResult> {
  const now = opts.now ?? new Date();
  const t = eventThreshold(c);
  if (t && !t.pass) return 'below_threshold';
  const engaged = await trx.selectFrom('loom.connections').select('id').where('business_id', '=', businessId).executeTakeFirst();
  if (!engaged) return 'not_engaged';
  const rule = CHANGE_RULES[c.type];
  const pending = await trx.selectFrom('loom.change_signals').select(['id']).where('business_id', '=', businessId).where('type', '=', c.type).where('scope', '=', c.scope)
    .where('status', '=', 'pending').forUpdate().executeTakeFirst();
  if (pending) {
    await trx.updateTable('loom.change_signals').set({ occurrences: sql`occurrences + 1`, last_seen_at: now, data: JSON.stringify(c.data), magnitude: t?.magnitude ?? null }).where('id', '=', pending.id).execute();
    return 'aggregated';
  }
  const cooling = await trx.selectFrom('loom.change_signals').select(['id']).where('business_id', '=', businessId).where('type', '=', c.type).where('scope', '=', c.scope)
    .where('status', '!=', 'pending').where('cooldown_until', '>', now).orderBy('processed_at', 'desc').limit(1).executeTakeFirst();
  if (cooling) {
    await trx.updateTable('loom.change_signals').set({ suppressed: sql`suppressed + 1`, last_seen_at: now }).where('id', '=', cooling.id).execute();
    return 'cooling_down';
  }
  const inserted = await trx.insertInto('loom.change_signals').values({
    business_id: businessId, type: c.type, scope: c.scope, data: JSON.stringify(c.data), magnitude: t?.magnitude ?? null, threshold: t?.threshold ?? rule.threshold,
    first_seen_at: now, last_seen_at: now, due_at: new Date(now.getTime() + rule.cooldown_min * 60_000),
  }).onConflict((oc) => oc.columns(['business_id', 'type', 'scope']).where('status', '=', 'pending').doNothing()).returning('id').executeTakeFirst();
  if (!inserted) {
    await trx.updateTable('loom.change_signals').set({ occurrences: sql`occurrences + 1`, last_seen_at: now }).where('business_id', '=', businessId)
      .where('type', '=', c.type).where('scope', '=', c.scope).where('status', '=', 'pending').execute();
    return 'aggregated';
  }
  return 'created';
}

// ── Processing ──────────────────────────────────────────────────────────────
type Live = {
  opportunity_id: string; initiative_id: string | null; artifact_kind: string | null; artifact_ref: string | null;
  offering_ids: string[]; window: { from: string; to: string }; card: CardContent; promoted: boolean; target: number | null;
};

async function liveItems(trx: Tx, businessId: string, today: string): Promise<Live[]> {
  const inits = await trx.selectFrom('loom.initiatives as i').innerJoin('loom.opportunities as o', 'o.id', 'i.opportunity_id')
    .select(['i.id', 'i.opportunity_id', 'i.artifact_kind', 'i.artifact_ref', 'i.offering_ids', 'i.window_from', 'i.window_to', 'i.original_proposal', 'o.card', 'o.subject'])
    .where('i.business_id', '=', businessId).where('i.status', 'in', ['scheduled', 'executing']).where('i.window_to', '>=', today).execute();
  const out: Live[] = inits.map((i) => ({
    opportunity_id: i.opportunity_id, initiative_id: i.id, artifact_kind: i.artifact_kind, artifact_ref: i.artifact_ref, offering_ids: i.offering_ids,
    window: { from: i.window_from, to: i.window_to }, card: i.card as CardContent, promoted: true,
    target: ((i.subject as { reserve?: { volume: number | null } }).reserve?.volume) ?? null,
  }));
  const withInit = new Set(out.map((x) => x.opportunity_id));
  const opps = await trx.selectFrom('loom.opportunities').select(['id', 'status', 'card', 'subject']).where('business_id', '=', businessId)
    .where('status', 'in', ['accepted', 'converted', 'executed', 'proposed', 'studying']).execute();
  for (const o of opps) {
    if (withInit.has(o.id)) continue;
    const card = o.card as CardContent;
    const subject = o.subject as { offering_ids?: string[]; reserve?: { volume: number | null } };
    out.push({ opportunity_id: o.id, initiative_id: null, artifact_kind: null, artifact_ref: null, offering_ids: subject.offering_ids ?? [], window: card.period, card,
      promoted: ['accepted', 'converted', 'executed'].includes(o.status), target: subject.reserve?.volume ?? null });
  }
  return out;
}

/** Booked ÷ (free + booked) of the staff qualified for an offering inside [from, to] ∩ the known capacity horizon. */
export function windowOccupancy(ctx: MetricContext, offeringId: string, w: { from: string; to: string }): number | null {
  const staff = new Set(ctx.qualifiedResources(offeringId));
  const s = Math.max(localToMs(w.from, '00:00', ctx.tz), ctx.now), e = Math.min(localToMs(addDays(w.to, 1), '00:00', ctx.tz), ctx.horizonEnd);
  if (!staff.size || e <= s) return null;
  const booked = ctx.minutes(['booked'], s, e, staff), free = ctx.minutes(['free'], s, e, staff);
  return booked + free > 0 ? round(booked / (booked + free)) : null;
}

/** Share of the qualified staff's scheduled time in [from, to] (∩ horizon) that a staff member's approved leave removes. */
export function leaveShrink(ctx: MetricContext, staffId: string, offeringId: string, w: { from: string; to: string }): number | null {
  const qualified = ctx.qualifiedResources(offeringId);
  if (!qualified.includes(staffId)) return null;
  const s = Math.max(localToMs(w.from, '00:00', ctx.tz), ctx.todayStart), e = Math.min(localToMs(addDays(w.to, 1), '00:00', ctx.tz), ctx.horizonEnd);
  if (e <= s) return null;
  const total = ctx.minutes(['free', 'booked', 'leave'], s, e, new Set(qualified));
  const leave = ctx.minutes(['leave'], s, e, new Set([staffId]));
  return total > 0 ? round(leave / total) : null;
}

const BAD: Record<'inventory' | 'capacity' | 'margin', string[]> = {
  inventory: ['reorder_needed', 'constrained'], capacity: ['blocked', 'constrained', 'unknown'], margin: ['negative', 'thin', 'costs_incomplete'],
};

type Recheck = { item: Live; offering_id: string; check: 'inventory' | 'capacity' | 'margin'; status: string; details: Record<string, unknown>; action: PlanRevisionChange['action']; note: Localized };

function recheck(ctx: MetricContext, reserved: Map<string, number>, it: Live, offeringId: string, check: Recheck['check'], forceAction?: PlanRevisionChange['action']): Recheck {
  if (check === 'inventory') {
    const r = checkInventory(ctx, offeringId, it.target);
    return { item: it, offering_id: offeringId, check, status: r.status, details: r as unknown as Record<string, unknown>, action: forceAction ?? (r.status === 'reorder_needed' ? 'restock_first' : 'review'), note: r.note };
  }
  if (check === 'capacity') {
    const own = it.promoted && it.target ? it.target : 0;
    const r = checkCapacity(ctx, offeringId, it.target, Math.max(0, (reserved.get(offeringId) ?? 0) - own));
    return { item: it, offering_id: offeringId, check, status: r.status, details: r as unknown as Record<string, unknown>, action: forceAction ?? (r.status === 'blocked' ? 'pause_promotion' : 'review'), note: r.note };
  }
  const r = checkMargin(ctx, offeringId, { discount_bp: it.card.recommended_action.discount_bp ?? null, baseline_volume: it.target });
  return { item: it, offering_id: offeringId, check, status: r.status, details: r as unknown as Record<string, unknown>, action: forceAction ?? 'review', note: r.note };
}

async function applyRecheck(trx: Tx, businessId: string, signalId: string, type: ChangeType, r: Recheck) {
  const row = await trx.selectFrom('loom.opportunities').select(['card', 'status']).where('business_id', '=', businessId).where('id', '=', r.item.opportunity_id).forUpdate().executeTakeFirstOrThrow();
  const card = row.card as CardContent;
  if (r.check === 'inventory') { const d = r.details as unknown as InventoryResult; card.inventory_check = { status: d.status, covers_n: d.covers_n, note: d.note }; }
  else if (r.check === 'capacity') { const d = r.details as unknown as CapacityResult; card.capacity_check = { status: d.status, max_additional: d.max_additional, note: d.note }; }
  else {
    const d = r.details as unknown as MarginResult;
    card.margin_check = { status: d.status, unit_margin_before_minor: d.unit_margin_before_minor, unit_margin_after_minor: d.unit_margin_after_minor, breakeven_volume_increase: d.breakeven_volume_increase, note: d.note };
  }
  await trx.updateTable('loom.opportunities').set({ card: JSON.stringify(card) }).where('id', '=', r.item.opportunity_id).execute();
  await trx.insertInto('loom.opportunity_checks').values({ business_id: businessId, opportunity_id: r.item.opportunity_id, analysis_id: null, check_type: r.check, status: r.status, details: JSON.stringify({ ...r.details, change_signal_id: signalId }) }).execute();
  await recordEvent(trx, businessId, r.item.opportunity_id, { event: 'reassessed', from: row.status, to: row.status, reason: `change:${type}`, data: { signal_id: signalId, check: r.check, status: r.status } });
}

export type ProcessSummary = { processed: number; not_relevant: number; below_threshold: number; rechecked: number; revisions: Array<{ plan_id: string; version: number; signal_id: string }> };

/**
 * Processes the due signals of one business. Loads the canonical dataset once
 * (through the connector), never calls a model. Idempotent: each pending
 * signal is claimed with SKIP LOCKED and processed exactly once.
 */
export async function processChanges(businessId: string, opts: { now?: Date; port?: PlanRevisionPort | null } = {}): Promise<ProcessSummary> {
  const now = opts.now ?? new Date();
  const port = opts.port === undefined ? planRevisionPort() : opts.port;
  const sum: ProcessSummary = { processed: 0, not_relevant: 0, below_threshold: 0, rechecked: 0, revisions: [] };
  const due = await withTenant(businessId, (trx) => trx.selectFrom('loom.change_signals').select(['id']).where('business_id', '=', businessId)
    .where('status', '=', 'pending').where('due_at', '<=', now).orderBy('due_at').limit(200).execute());
  if (!due.length) return sum;
  const platform = await withSystem('loom: settings for change aggregation', (trx) => readPlatformSettings(trx));
  const conn = await withTenant(businessId, (trx) => ensureConnection(trx, businessId));
  const connector = connectorFor(conn.kind);
  const ds: CanonicalDataset = await loadDataset(connector, { ...conn, as_of: now });
  const ctx = new MetricContext(ds, { cost_completeness_threshold: platform.cost_completeness_threshold });

  for (const { id } of due) {
    const outcome = await withTenant(businessId, async (trx) => {
      const sig = await trx.selectFrom('loom.change_signals').selectAll().where('id', '=', id).where('status', '=', 'pending').forUpdate().skipLocked().executeTakeFirst();
      if (!sig) return null;
      const type = sig.type as ChangeType;
      const items = await liveItems(trx, businessId, ds.meta.today);
      const reserved = await reservedVolumes(trx, businessId);
      const data = sig.data as Record<string, unknown>;
      const ref = sig.scope.split(':')[1]!;
      let status: 'processed' | 'not_relevant' | 'below_threshold' = 'processed';
      let magnitude: number | null = sig.magnitude;
      const checks: Recheck[] = [];
      const affectedOfferings = new Set<string>();
      const result: Record<string, unknown> = {};

      if (type === 'inventory') {
        const item = ds.inventory.find((x) => x.id === ref);
        const available = item ? item.on_hand - item.reserved : null;
        const low = item && available !== null && (available <= 0 || (item.reorder_level !== null && available <= item.reorder_level));
        const offerings = new Set(ds.requirements.filter((r) => r.type === 'material' && r.ref_id === ref).map((r) => r.offering_id));
        magnitude = available;
        if (!low) status = 'below_threshold';
        else if (!items.some((it) => it.promoted && it.offering_ids.some((o) => offerings.has(o)))) status = 'not_relevant';
        else for (const it of items) for (const o of it.offering_ids) if (offerings.has(o)) { affectedOfferings.add(o); checks.push(recheck(ctx, reserved, it, o, 'inventory')); }
      } else if (type === 'occupancy') {
        let max: number | null = null;
        for (const it of items.filter((x) => x.promoted && x.offering_ids.includes(ref))) {
          const occ = windowOccupancy(ctx, ref, it.window);
          if (occ !== null) max = Math.max(max ?? 0, occ);
          // Full window: freeze the promotion there (pause) and re-check capacity.
          if (occ !== null && occ > CHANGE_RULES.occupancy.threshold) { affectedOfferings.add(ref); checks.push(recheck(ctx, reserved, it, ref, 'capacity', 'pause_promotion')); }
        }
        magnitude = max;
        if (!items.some((x) => x.promoted && x.offering_ids.includes(ref))) status = 'not_relevant';
        else if (!checks.length) status = 'below_threshold';
      } else if (type === 'capacity') {
        let max: number | null = null;
        const promoted = items.filter((x) => x.promoted);
        for (const it of promoted) for (const o of it.offering_ids) {
          const shrink = leaveShrink(ctx, ref, o, it.window);
          if (shrink !== null) max = Math.max(max ?? 0, shrink);
          if (shrink !== null && shrink > CHANGE_RULES.capacity.threshold) { affectedOfferings.add(o); checks.push(recheck(ctx, reserved, it, o, 'capacity')); }
        }
        magnitude = max;
        if (max === null) status = 'not_relevant';
        else if (!checks.length) status = 'below_threshold';
      } else if (type === 'margin') {
        if (!items.some((x) => x.offering_ids.includes(ref))) status = 'not_relevant';
        else for (const it of items.filter((x) => x.offering_ids.includes(ref))) { affectedOfferings.add(ref); checks.push(recheck(ctx, reserved, it, ref, 'margin')); }
      } else {
        // campaign_result: learning — an inferred fact the planner and the ranking can read.
        const init = await trx.selectFrom('loom.initiatives').select(['id', 'opportunity_id', 'category', 'measurement_quality', 'learnings']).where('business_id', '=', businessId).where('id', '=', ref).executeTakeFirst();
        if (!init) status = 'not_relevant';
        else {
          await writeFact(trx, businessId, { key: `learning.initiative:${init.id}`, value: { category: init.category, quality: init.measurement_quality, learnings: init.learnings, campaign_id: data.campaign_id ?? null }, kind: 'inferred', source_type: 'metric', source_ref: `outcome:${init.id}`, confidence: init.measurement_quality === 'experimental' ? 'high' : 'low' });
          result.learning_fact = `learning.initiative:${init.id}`;
        }
      }

      for (const r of checks) { await applyRecheck(trx, businessId, sig.id, type, r); sum.rechecked++; }
      // Plan items that need a revision: affected plan_action initiatives whose re-check is no longer ok (or a frozen full window).
      const planChanges = new Map<string, PlanRevisionChange[]>();
      for (const r of checks) {
        if (r.item.artifact_kind !== 'plan_action' || !r.item.artifact_ref) continue;
        if (r.action !== 'pause_promotion' && !BAD[r.check].includes(r.status)) continue;
        const list = planChanges.get(r.item.artifact_ref) ?? [];
        list.push({ opportunity_id: r.item.opportunity_id, initiative_id: r.item.initiative_id, check: r.check, status: r.status, action: r.action, title: r.item.card.title, evidence_refs: r.item.card.evidence_refs, note: r.note });
        planChanges.set(r.item.artifact_ref, list);
      }
      const rule = CHANGE_RULES[type];
      const full = { ...result, offering_ids: [...affectedOfferings], rechecked: checks.map((c) => ({ opportunity_id: c.item.opportunity_id, check: c.check, status: c.status })), plans_pending: [...planChanges.keys()] };
      await trx.updateTable('loom.change_signals').set({
        status, magnitude, processed_at: now, cooldown_until: new Date(now.getTime() + rule.cooldown_min * 60_000), result: JSON.stringify(full),
      }).where('id', '=', sig.id).execute();
      return { status, planChanges, type, signalId: sig.id, full };
    });
    if (!outcome) continue;
    if (outcome.status === 'processed') sum.processed++; else if (outcome.status === 'not_relevant') sum.not_relevant++; else sum.below_threshold++;
    if (!outcome.planChanges.size) continue;
    const revisions: Array<{ plan_id: string; version: number; version_id: string }> = [];
    const reason: PlanRevisionReason = { code: outcome.type, text: CHANGE_RULES[outcome.type].label, signal_id: outcome.signalId };
    if (port) {
      const approved = await port.approvedPlans(businessId, [...outcome.planChanges.keys()]);
      for (const p of approved) {
        const r = await port.proposePlanRevision(businessId, p.plan_id, reason, outcome.planChanges.get(p.plan_id)!);
        revisions.push({ plan_id: r.plan_id, version: r.version, version_id: r.version_id });
        sum.revisions.push({ plan_id: r.plan_id, version: r.version, signal_id: outcome.signalId });
      }
    }
    await withTenant(businessId, (trx) => trx.updateTable('loom.change_signals').set({
      result: JSON.stringify({ ...outcome.full, revisions, port: port ? 'registered' : 'none' }),
    }).where('id', '=', outcome.signalId).execute());
  }
  return sum;
}

// ── Jobs ────────────────────────────────────────────────────────────────────
export const CHANGES_JOB = 'loom.changes';

/** Periodic fan-out: one `loom.changes` job per business with due signals (deduplicated per 5-minute bucket). */
export async function scheduleDueChanges(now = new Date()) {
  const rows = await withSystem('loom: due change signals', (trx) => trx.selectFrom('loom.change_signals').select('business_id').distinct()
    .where('status', '=', 'pending').where('due_at', '<=', now).execute());
  const bucket = Math.floor(now.getTime() / 300_000);
  for (const r of rows) {
    await withTenant(r.business_id, (trx) => schedule(trx, CHANGES_JOB, {}, { tenantId: r.business_id, dedupeKey: `loom_changes:${r.business_id}:${bucket}`, maxAttempts: 3 }));
  }
  return rows.length;
}
