import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { effectiveCapabilities, type TenantRole } from '../../auth/capabilities';
import { env } from '../../env';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { channelStatus } from '../../infra/messaging';
import { notifyUsers } from '../../infra/notify';
import { schedule } from '../../infra/outbox';
import { loadEntitlements, type TenantAccess } from '../../tenancy/access';
import type { campaignInput, campaignPatch, SegmentDefinition } from '@/shared/schemas/marketing';
import { createSegment, segmentMembers } from './segments';

/**
 * Campaigns (§31). Sending requires ALL of: an approval by someone holding
 * campaigns.approve (audited), the campaigns plan feature, an enabled channel
 * (no provider + no dev simulation ⇒ channel_disconnected) and, per recipient,
 * the latest channel-specific marketing consent, no suppression/opt-out, the
 * frequency cap and the business's quiet hours. Development without a provider
 * records clearly labelled *simulated* deliveries; nothing leaves the server.
 */

export const CAMPAIGN_SEND_JOB = 'marketing.campaign_send';
export const MIN_GROUP_FOR_INCREMENTAL = 30;
type Channel = 'email' | 'sms' | 'whatsapp' | 'in_app';

export function channelReadiness(channel: Channel): 'connected' | 'dev_simulation' | 'disconnected' {
  if (channel === 'in_app') return 'connected';
  return channelStatus(channel);
}

export function destinationHash(channel: string, destination: string) {
  const norm = channel === 'email' ? destination.trim().toLowerCase() : destination.replace(/[^\d+]/g, '');
  return createHash('sha256').update(`${channel}:${norm}`).digest();
}

const trackingCode = () => `L-${randomBytes(4).toString('hex').toUpperCase()}`;

async function loadCampaign(trx: Tx, id: string, lock = false) {
  let q = trx.selectFrom('campaigns').selectAll().where('id', '=', id);
  if (lock) q = q.forUpdate();
  const c = await q.executeTakeFirst();
  if (!c) throw Errors.notFound('campaign');
  return c;
}

export async function listCampaigns(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => trx.selectFrom('campaigns as c').leftJoin('campaign_segments as s', 's.id', 'c.segment_id')
    .select(['c.id', 'c.name', 'c.channel', 'c.status', 'c.scheduled_at', 'c.approved_at', 'c.started_at', 'c.finished_at', 'c.stats', 'c.tracking_code', 'c.created_at', 'c.last_error', 's.name as segment_name'])
    .where('c.tenant_id', '=', access.tenantId).orderBy('c.created_at', 'desc').limit(100).execute());
}

export async function getCampaign(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id);
    return { ...c, channel_status: channelReadiness(c.channel as Channel) };
  });
}

export async function createCampaign(access: TenantAccess, actor: AuditActor, input: z.infer<typeof campaignInput>, trxIn?: Tx) {
  const run = async (trx: Tx) => {
    const code = trackingCode();
    const row = await trx.insertInto('campaigns').values({
      tenant_id: access.tenantId, name: input.name, channel: input.channel, segment_id: input.segment_id, content: JSON.stringify(input.content), status: 'draft',
      holdout_bp: input.holdout_bp, attribution_window_days: input.attribution_window_days, frequency_cap_days: input.frequency_cap_days,
      quiet_hours: JSON.stringify(input.quiet_hours), recommendation_id: input.recommendation_id ?? null, plan_id: input.plan_id ?? null,
      tracking_code: code, utm: JSON.stringify({ source: 'luma', medium: input.channel, campaign: code }), created_by: actor.userId,
    }).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'marketing.campaign_created', { tenantId: access.tenantId, targetType: 'campaign', targetId: row.id, data: { channel: input.channel } });
    return row;
  };
  return trxIn ? run(trxIn) : withTenant(access.tenantId, run);
}

export async function updateCampaign(access: TenantAccess, actor: AuditActor, id: string, patch: z.infer<typeof campaignPatch>) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id, true);
    if (c.status !== 'draft') throw Errors.conflict('campaign_locked', 'Only drafts can be edited; cancel and create a new draft instead');
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'channel', 'segment_id', 'holdout_bp', 'attribution_window_days', 'frequency_cap_days'] as const) if (patch[k] !== undefined) set[k] = patch[k];
    if (patch.content) set.content = JSON.stringify(patch.content);
    if (patch.quiet_hours) set.quiet_hours = JSON.stringify(patch.quiet_hours);
    if (patch.channel) set.utm = JSON.stringify({ source: 'luma', medium: patch.channel, campaign: c.tracking_code });
    const row = await trx.updateTable('campaigns').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    await audit(trx, actor, 'marketing.campaign_updated', { tenantId: access.tenantId, targetType: 'campaign', targetId: id, data: { fields: Object.keys(set) } });
    return row;
  });
}

/** Draft from a recommendation (its suggested segment is created on conversion). */
export async function campaignFromRecommendation(access: TenantAccess, actor: AuditActor, recId: string) {
  return withTenant(access.tenantId, async (trx) => {
    const r = await trx.selectFrom('recommendations').selectAll().where('id', '=', recId).forUpdate().executeTakeFirst();
    if (!r) throw Errors.notFound('recommendation');
    const draft = (r.draft_content ?? {}) as { text?: string | null; segment_definition?: SegmentDefinition };
    let segmentId = r.target_segment_id;
    if (!segmentId && draft.segment_definition) {
      const seg = await createSegment(access, actor, { name: r.title.slice(0, 120), description: r.opportunity.slice(0, 500), definition: draft.segment_definition }, trx);
      segmentId = seg.id;
    }
    const channel: Channel = (['email', 'sms', 'whatsapp', 'in_app'] as const).find((c) => c === r.channel) ?? 'in_app';
    const c = await createCampaign(access, actor, {
      name: r.title.slice(0, 120), channel, segment_id: segmentId, content: { body: (draft.text || r.suggested_action).slice(0, 1500) },
      holdout_bp: 1000, attribution_window_days: 14, frequency_cap_days: 7, quiet_hours: { from: '21:00', to: '09:00' }, recommendation_id: r.id,
    }, trx);
    await trx.updateTable('recommendations').set({ status: 'accepted', decided_by: actor.userId, decided_at: new Date(), target_segment_id: segmentId }).where('id', '=', recId).execute();
    return c;
  });
}

export async function campaignFromPlan(access: TenantAccess, actor: AuditActor, planId: string, activityId?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const p = await trx.selectFrom('marketing_plans as p').innerJoin('plan_versions as v', 'v.id', 'p.current_version_id')
      .select(['p.id', 'p.title', 'p.is_example', 'v.content']).where('p.id', '=', planId).executeTakeFirst();
    if (!p) throw Errors.notFound('plan');
    if (p.is_example) throw Errors.invalid('example_plan', 'An example plan cannot become a campaign');
    const acts = (p.content as { activities: Array<{ id: string; title: string; channel: string | null; content_idea: string | null }> }).activities;
    const a = activityId ? acts.find((x) => x.id === activityId) : acts[0];
    if (!a) throw Errors.notFound('activity');
    const channel: Channel = (['email', 'sms', 'whatsapp', 'in_app'] as const).find((c) => c === a.channel) ?? 'in_app';
    return createCampaign(access, actor, {
      name: a.title.slice(0, 120), channel, segment_id: null, content: { body: (a.content_idea || a.title).slice(0, 1500) },
      holdout_bp: 1000, attribution_window_days: 14, frequency_cap_days: 7, quiet_hours: { from: '21:00', to: '09:00' }, plan_id: p.id,
    }, trx);
  });
}

export async function approveCampaign(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id, true);
    if (c.status !== 'draft') throw Errors.conflict('invalid_transition', 'Only drafts can be approved', { status: c.status });
    if (!c.segment_id) throw Errors.invalid('segment_required', 'Choose an audience segment before approval');
    await trx.updateTable('campaigns').set({ status: 'approved', approved_by: actor.userId, approved_at: new Date() }).where('id', '=', id).execute();
    await audit(trx, actor, 'marketing.campaign_approved', { tenantId: access.tenantId, targetType: 'campaign', targetId: id, data: { channel: c.channel, segment_id: c.segment_id } });
    return { id, status: 'approved' };
  });
}

export async function scheduleCampaign(access: TenantAccess, actor: AuditActor, id: string, at?: Date) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id, true);
    if (!['approved', 'paused'].includes(c.status) || !c.approved_by) throw Errors.conflict('approval_required', 'The campaign must be approved before it can be scheduled');
    const ready = channelReadiness(c.channel as Channel);
    if (ready === 'disconnected') throw Errors.conflict('channel_disconnected', 'No provider is connected for this channel; the campaign cannot start');
    const when = at && at > new Date() ? at : new Date();
    await trx.updateTable('campaigns').set({ status: 'scheduled', scheduled_at: when, last_error: null }).where('id', '=', id).execute();
    await schedule(trx, CAMPAIGN_SEND_JOB, { campaign_id: id }, { tenantId: access.tenantId, runAt: when, dedupeKey: `campaign_send:${id}:${when.getTime()}`, maxAttempts: 3 });
    await audit(trx, actor, 'marketing.campaign_scheduled', { tenantId: access.tenantId, targetType: 'campaign', targetId: id, data: { at: when.toISOString(), channel_status: ready } });
    return { id, status: 'scheduled', scheduled_at: when, channel_status: ready };
  });
}

export async function cancelCampaign(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id, true);
    if (!['draft', 'approved', 'scheduled', 'paused'].includes(c.status)) throw Errors.conflict('invalid_transition', 'This campaign can no longer be cancelled', { status: c.status });
    await trx.updateTable('campaigns').set({ status: 'cancelled', cancelled_at: new Date() }).where('id', '=', id).execute();
    await audit(trx, actor, 'marketing.campaign_cancelled', { tenantId: access.tenantId, targetType: 'campaign', targetId: id, data: { from: c.status } });
    return { id, status: 'cancelled' };
  });
}

export async function pauseCampaign(access: TenantAccess, actor: AuditActor, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id, true);
    if (c.status !== 'scheduled') throw Errors.conflict('invalid_transition', 'Only scheduled campaigns can be paused', { status: c.status });
    await trx.updateTable('campaigns').set({ status: 'paused' }).where('id', '=', id).execute();
    await audit(trx, actor, 'marketing.campaign_paused', { tenantId: access.tenantId, targetType: 'campaign', targetId: id });
    return { id, status: 'paused' };
  });
}

export async function addSuppression(access: TenantAccess, actor: AuditActor, channel: 'email' | 'sms' | 'whatsapp', destination: string, reason: 'unsubscribed' | 'manual' = 'manual') {
  return withTenant(access.tenantId, async (trx) => {
    await trx.insertInto('suppression_list').values({ tenant_id: access.tenantId, channel, destination_hash: destinationHash(channel, destination), reason })
      .onConflict((oc) => oc.columns(['tenant_id', 'channel', 'destination_hash']).doNothing()).execute();
    await audit(trx, actor, 'marketing.suppression_added', { tenantId: access.tenantId, data: { channel, reason } });
    return { suppressed: true };
  });
}

// ── Sending ──────────────────────────────────────────────────────────────────
function toMin(hhmm: string) { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; }

/** If `now` falls in quiet hours (tenant-local), returns the instant they end. */
export function quietHoursEnd(now: Date, tz: string, q: { from: string; to: string }): Date | null {
  const local = DateTime.fromJSDate(now, { zone: tz });
  const cur = local.hour * 60 + local.minute;
  const from = toMin(q.from), to = toMin(q.to);
  if (from === to) return null;
  const inQuiet = from < to ? cur >= from && cur < to : cur >= from || cur < to;
  if (!inQuiet) return null;
  let end = local.set({ hour: Math.floor(to / 60), minute: to % 60, second: 0, millisecond: 0 });
  if (end <= local) end = end.plus({ days: 1 });
  return end.toJSDate();
}

const holdoutBucket = (campaignId: string, customerId: string) => createHash('sha256').update(`${campaignId}:${customerId}`).digest().readUInt32BE(0) % 10000;

type SendOutcome = { status: string; [k: string]: unknown };

/** Job body. Re-verifies every gate at send time; safe to re-run (status guard + transaction). */
export async function runCampaignSend(tenantId: string, campaignId: string, opts: { now?: Date } = {}): Promise<SendOutcome> {
  const now = opts.now ?? new Date();
  return withTenant(tenantId, async (trx) => {
    const c = await loadCampaign(trx, campaignId, true);
    if (c.status !== 'scheduled') return { status: 'skipped', reason: `status_${c.status}` };
    const fail = async (code: string) => {
      await trx.updateTable('campaigns').set({ status: 'failed', last_error: code, finished_at: now }).where('id', '=', campaignId).execute();
      await audit(trx, { userId: null, kind: 'system' }, 'marketing.campaign_send_blocked', { tenantId, targetType: 'campaign', targetId: campaignId, data: { reason: code } });
      return { status: 'failed', reason: code };
    };
    const ent = await loadEntitlements(trx, tenantId);
    if (!ent.features.get('feature.campaigns')?.enabled) return fail('plan_feature_unavailable');
    if (!c.approved_by) return fail('approval_required');
    const approver = await trx.selectFrom('tenant_memberships').select(['role', 'granted_capabilities', 'revoked_capabilities', 'status']).where('user_id', '=', c.approved_by).executeTakeFirst();
    if (!approver || approver.status !== 'active' || !effectiveCapabilities(approver.role as TenantRole, approver.granted_capabilities, approver.revoked_capabilities).has('campaigns.approve')) return fail('approver_lacks_permission');
    const channel = c.channel as Channel;
    const readiness = channelReadiness(channel);
    if (readiness === 'disconnected') return fail('channel_disconnected');
    if (!c.segment_id) return fail('segment_required');

    const t = await trx.selectFrom('tenants').select(['timezone', 'name']).where('id', '=', tenantId).executeTakeFirstOrThrow();
    const quietEnd = quietHoursEnd(now, t.timezone, c.quiet_hours as { from: string; to: string });
    if (quietEnd) {
      await trx.updateTable('campaigns').set({ scheduled_at: quietEnd }).where('id', '=', campaignId).execute();
      await schedule(trx, CAMPAIGN_SEND_JOB, { campaign_id: campaignId }, { tenantId, runAt: quietEnd, dedupeKey: `campaign_send:${campaignId}:${quietEnd.getTime()}`, maxAttempts: 3 });
      return { status: 'deferred_quiet_hours', until: quietEnd.toISOString() };
    }

    await trx.updateTable('campaigns').set({ status: 'sending', started_at: now }).where('id', '=', campaignId).execute();
    const seg = await trx.selectFrom('campaign_segments').select(['definition']).where('id', '=', c.segment_id).executeTakeFirstOrThrow();
    const members = await segmentMembers(trx, tenantId, seg.definition as SegmentDefinition);
    const content = c.content as { subject?: string; body: string; deep_link?: string };
    const consentCh = channel === 'in_app' ? 'push' : channel;
    const stats = { audience: members.length, holdout: 0, delivered: 0, simulated: 0, suppressed: {} as Record<string, number> };
    const events: Array<{ tenant_customer_id: string; kind: string; data: Record<string, unknown> }> = [];
    const suppress = (id: string, reason: string) => { stats.suppressed[reason] = (stats.suppressed[reason] ?? 0) + 1; events.push({ tenant_customer_id: id, kind: 'suppressed', data: { reason } }); };

    for (const m of members) {
      events.push({ tenant_customer_id: m.id, kind: 'targeted', data: {} });
      if (holdoutBucket(campaignId, m.id) < c.holdout_bp) { stats.holdout++; events.push({ tenant_customer_id: m.id, kind: 'holdout', data: {} }); continue; }
      const consent = await sql<{ granted: boolean }>`select cc.granted from customer_consents cc
        where cc.tenant_id = ${tenantId} and cc.channel = ${consentCh} and cc.purpose = 'marketing'
          and (cc.tenant_customer_id = ${m.id}::uuid or (${m.user_id}::uuid is not null and cc.user_id = ${m.user_id}::uuid))
        order by cc.recorded_at desc limit 1`.execute(trx);
      if (consent.rows[0]?.granted !== true) { suppress(m.id, consent.rows.length ? 'opted_out' : 'no_consent'); continue; }
      const dest = channel === 'email' ? m.email : channel === 'in_app' ? m.user_id : m.phone;
      if (!dest) { suppress(m.id, channel === 'in_app' ? 'no_luma_account' : 'no_destination'); continue; }
      if (channel !== 'in_app') {
        const s = await trx.selectFrom('suppression_list').select('id').where('tenant_id', '=', tenantId).where('channel', '=', channel).where('destination_hash', '=', destinationHash(channel, dest)).executeTakeFirst();
        if (s) { suppress(m.id, 'suppression_list'); continue; }
      }
      if (c.frequency_cap_days > 0) {
        const recent = await trx.selectFrom('campaign_events').select('id').where('tenant_id', '=', tenantId).where('tenant_customer_id', '=', m.id)
          .where('kind', 'in', ['sent', 'simulated']).where('campaign_id', '!=', campaignId)
          .where('created_at', '>', new Date(now.getTime() - c.frequency_cap_days * 86_400_000)).executeTakeFirst();
        if (recent) { suppress(m.id, 'frequency_cap'); continue; }
      }
      if (channel === 'in_app') {
        await notifyUsers(trx, tenantId, [dest], {
          kind: 'marketing.campaign', title_ar: content.subject ?? t.name, title_en: content.subject ?? t.name, body_ar: content.body, body_en: content.body,
          target_path: content.deep_link ? `${content.deep_link}${content.deep_link.includes('?') ? '&' : '?'}utm_source=luma&utm_medium=in_app&utm_campaign=${c.tracking_code}` : undefined,
          data: { campaign_id: campaignId, tracking_code: c.tracking_code }, dedupe_key: `campaign:${campaignId}:${m.id}`,
        });
        stats.delivered++;
        events.push({ tenant_customer_id: m.id, kind: 'sent', data: { channel } });
      } else if (readiness === 'dev_simulation') {
        // No provider: development simulation only — clearly labelled, nothing leaves the server.
        await trx.insertInto('dev_message_outbox').values({ destination: dest, channel, subject: `[SIMULATED CAMPAIGN ${c.tracking_code}] ${content.subject ?? ''}`.trim(), body: content.body }).execute();
        stats.simulated++;
        events.push({ tenant_customer_id: m.id, kind: 'simulated', data: { channel, provider: 'dev-outbox' } });
      }
    }
    if (events.length) {
      for (let i = 0; i < events.length; i += 500) {
        await trx.insertInto('campaign_events').values(events.slice(i, i + 500).map((e) => ({ tenant_id: tenantId, campaign_id: campaignId, tenant_customer_id: e.tenant_customer_id, kind: e.kind, data: JSON.stringify(e.data), created_at: now }))).execute();
      }
    }
    await trx.updateTable('campaigns').set({ status: 'sent', finished_at: now, stats: JSON.stringify({ ...stats, simulated_only: readiness === 'dev_simulation' && channel !== 'in_app' }) }).where('id', '=', campaignId).execute();
    await audit(trx, { userId: null, kind: 'system' }, 'marketing.campaign_sent', { tenantId, targetType: 'campaign', targetId: campaignId, data: { ...stats, channel, simulated: readiness === 'dev_simulation' } });
    return { status: 'sent', ...stats };
  });
}

// ── Results & attribution ────────────────────────────────────────────────────
/**
 * Attribution: completed bookings by delivered recipients created within the
 * disclosed window after the send, plus bookings carrying this campaign's id.
 * Value = total − refunds; cancelled/no-show bookings never count. Conversions
 * are recorded once (unique index). Incremental revenue needs a holdout group
 * of sufficient size; otherwise it is reported as insufficient sample.
 */
export async function campaignResults(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const c = await loadCampaign(trx, id);
    const stats = (c.stats ?? {}) as Record<string, unknown>;
    if (!c.started_at) return { campaign_id: id, status: c.status, stats, results: null, disclosure: { attribution_window_days: c.attribution_window_days } };
    const windowEnd = new Date(c.started_at.getTime() + c.attribution_window_days * 86_400_000);
    const groups = await sql<{ grp: string; members: number; converters: number; bookings: number; net_minor: number }>`
      with g as (
        select distinct tenant_customer_id as c, case when kind = 'holdout' then 'holdout' else 'delivered' end as grp
        from campaign_events where tenant_id = ${access.tenantId} and campaign_id = ${id} and kind in ('sent', 'simulated', 'holdout')
      ),
      b as (
        select bk.id, bk.tenant_customer_id as c, bk.total_minor - bk.refunded_minor as net from bookings bk
        where bk.tenant_id = ${access.tenantId} and bk.status = 'completed' and bk.created_at >= ${c.started_at} and bk.created_at < ${windowEnd}
      )
      select g.grp, count(distinct g.c)::int as members, count(distinct b.c)::int as converters, count(b.id)::int as bookings, coalesce(sum(b.net), 0)::bigint as net_minor
      from g left join b on b.c = g.c group by g.grp`.execute(trx);
    const direct = await sql<{ id: string; c: string; net: number }>`select id, tenant_customer_id as c, total_minor - refunded_minor as net from bookings
      where tenant_id = ${access.tenantId} and campaign_id = ${id} and status = 'completed'`.execute(trx);
    // Record conversions once (dedupe by booking).
    const delivered = await sql<{ id: string; c: string; net: number }>`
      select bk.id, bk.tenant_customer_id as c, bk.total_minor - bk.refunded_minor as net from bookings bk
      where bk.tenant_id = ${access.tenantId} and bk.status = 'completed' and bk.created_at >= ${c.started_at} and bk.created_at < ${windowEnd}
        and exists (select 1 from campaign_events e where e.campaign_id = ${id} and e.tenant_customer_id = bk.tenant_customer_id and e.kind in ('sent', 'simulated'))`.execute(trx);
    const conv = new Map([...delivered.rows, ...direct.rows].map((r) => [r.id, r]));
    for (const r of conv.values()) {
      await sql`insert into campaign_events (tenant_id, campaign_id, tenant_customer_id, kind, ref_type, ref_id, value_minor)
        values (${access.tenantId}, ${id}, ${r.c}, 'converted', 'booking', ${r.id}, ${r.net})
        on conflict (campaign_id, ref_type, ref_id) where kind = 'converted' do nothing`.execute(trx);
    }
    const g = Object.fromEntries(groups.rows.map((r) => [r.grp, r]));
    const t = g.delivered ?? { members: 0, converters: 0, bookings: 0, net_minor: 0 };
    const h = g.holdout ?? { members: 0, converters: 0, bookings: 0, net_minor: 0 };
    const attributed = [...conv.values()].reduce((m, r) => m + Number(r.net), 0);
    const enough = t.members >= MIN_GROUP_FOR_INCREMENTAL && h.members >= MIN_GROUP_FOR_INCREMENTAL;
    const rateT = t.members ? t.converters / t.members : null, rateH = h.members ? h.converters / h.members : null;
    return {
      campaign_id: id, status: c.status, stats,
      results: {
        delivered: { members: t.members, converters: t.converters, bookings: t.bookings, net_minor: Number(t.net_minor), conversion_rate: rateT },
        holdout: { members: h.members, converters: h.converters, bookings: h.bookings, net_minor: Number(h.net_minor), conversion_rate: rateH },
        attributed_net_minor: attributed,
        conversions_recorded: conv.size,
        incremental: enough && rateT !== null && rateH !== null
          ? { status: 'estimated', net_minor: Math.round(Number(t.net_minor) - Number(h.net_minor) * (t.members / h.members)), conversion_rate_lift: rateT - rateH }
          : { status: 'insufficient_sample', min_group: MIN_GROUP_FOR_INCREMENTAL },
      },
      disclosure: {
        attribution_window_days: c.attribution_window_days, window_end: windowEnd.toISOString(),
        counts: 'completed_bookings_net_of_refunds', excludes: ['cancelled', 'no_show'],
        attributed_is_not_incremental: true, before_after_not_causal: true,
        simulated_only: !!stats.simulated_only, tracking_code: c.tracking_code, utm: c.utm,
      },
    };
  });
}

export const _test = { holdoutBucket, isProd: () => env().isProduction };
