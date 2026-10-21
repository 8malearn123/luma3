import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { type TenantAccess } from '../../tenancy/access';
import { addDays, localToday, monthBounds } from '../analytics/period';
import { planContent, type createPlanInput, type PLAN_ACTIONS, type PlanContent, type PlanStatus, type planVersionInput } from '@/shared/schemas/marketing';
import { examplePlan } from './rules';

/**
 * Marketing plans with append-only versions.
 *  - current_version_id: the latest version; approved_version_id: what is in effect.
 *  - Edits and regenerations ALWAYS append a version. An approved plan's approved
 *    version never changes until the owner explicitly approves a newer one.
 */

type Source = 'ai' | 'rules' | 'manual' | 'example';

async function nextVersion(trx: Tx, planId: string) {
  const r = await trx.selectFrom('plan_versions').select(sql<number>`coalesce(max(version), 0)::int`.as('v')).where('plan_id', '=', planId).executeTakeFirstOrThrow();
  return r.v + 1;
}

export async function appendVersion(trx: Tx, tenantId: string, planId: string, v: {
  content: PlanContent; source: Source; createdBy: string | null; aiRunId?: string | null; snapshotId?: string | null; validation?: Record<string, unknown>; changeNote?: string | null;
}) {
  planContent.parse(v.content);
  const version = await nextVersion(trx, planId);
  const row = await trx.insertInto('plan_versions').values({
    tenant_id: tenantId, plan_id: planId, version, content: JSON.stringify(v.content), source: v.source, ai_run_id: v.aiRunId ?? null,
    metric_snapshot_id: v.snapshotId ?? null, validation: JSON.stringify(v.validation ?? {}), change_note: v.changeNote ?? null, created_by: v.createdBy,
  }).returning(['id', 'version']).executeTakeFirstOrThrow();
  await trx.updateTable('marketing_plans').set({ current_version_id: row.id }).where('id', '=', planId).execute();
  return row;
}

/**
 * Saves generated content: appends to the target plan (regeneration) or to the
 * live plan of the same kind/period, otherwise creates a new proposed plan.
 */
export async function saveGeneratedPlan(trx: Tx, tenantId: string, g: {
  kind: 'monthly' | 'weekly'; from: string; to: string; title: string; content: PlanContent; source: Source;
  parentPlanId?: string | null; targetPlanId?: string | null; aiRunId?: string | null; snapshotId?: string | null; validation?: Record<string, unknown>; createdBy?: string | null;
}) {
  let plan = g.targetPlanId
    ? await trx.selectFrom('marketing_plans').selectAll().where('id', '=', g.targetPlanId).where('tenant_id', '=', tenantId).executeTakeFirst()
    : await trx.selectFrom('marketing_plans').selectAll().where('tenant_id', '=', tenantId).where('kind', '=', g.kind).where('period_start', '=', g.from)
      .where('is_example', '=', false).where('status', 'not in', ['rejected', 'completed']).orderBy('created_at', 'desc').executeTakeFirst();
  let created = false;
  if (!plan) {
    plan = await trx.insertInto('marketing_plans').values({
      tenant_id: tenantId, kind: g.kind, parent_plan_id: g.parentPlanId ?? null, period_start: g.from, period_end: g.to, title: g.title,
      status: 'proposed', created_by: g.createdBy ?? null,
    }).returningAll().executeTakeFirstOrThrow();
    created = true;
  }
  const v = await appendVersion(trx, tenantId, plan.id, {
    content: g.content, source: g.source, createdBy: g.createdBy ?? null, aiRunId: g.aiRunId, snapshotId: g.snapshotId, validation: g.validation,
    changeNote: created ? null : 'regenerated',
  });
  return { plan_id: plan.id, version_id: v.id, version: v.version, created };
}

export async function listPlans(access: TenantAccess, kind?: 'monthly' | 'weekly') {
  return withTenant(access.tenantId, async (trx) => {
    let q = trx.selectFrom('marketing_plans as p')
      .leftJoin('plan_versions as cv', 'cv.id', 'p.current_version_id')
      .leftJoin('plan_versions as av', 'av.id', 'p.approved_version_id')
      .select(['p.id', 'p.kind', 'p.parent_plan_id', 'p.period_start', 'p.period_end', 'p.title', 'p.status', 'p.is_example', 'p.created_at', 'p.updated_at',
        'p.approved_at', 'cv.version as current_version', 'cv.source as current_source', 'av.version as approved_version'])
      .where('p.tenant_id', '=', access.tenantId);
    if (kind) q = q.where('p.kind', '=', kind);
    return q.orderBy('p.period_start', 'desc').orderBy('p.created_at', 'desc').limit(100).execute();
  });
}

export async function getPlan(access: TenantAccess, id: string) {
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.selectFrom('marketing_plans').selectAll().where('id', '=', id).executeTakeFirst();
    if (!plan) throw Errors.notFound('plan');
    const versions = await trx.selectFrom('plan_versions as v').leftJoin('ai_runs as r', 'r.id', 'v.ai_run_id')
      .select(['v.id', 'v.version', 'v.content', 'v.source', 'v.validation', 'v.change_note', 'v.created_at', 'v.created_by', 'v.metric_snapshot_id',
        'r.provider', 'r.model', 'r.prompt_version', 'r.input_tokens', 'r.output_tokens', 'r.cost_usd_micros'])
      .where('v.plan_id', '=', id).orderBy('v.version', 'desc').execute();
    const comments = await trx.selectFrom('plan_comments as c').innerJoin('users as u', 'u.id', 'c.author_id')
      .select(['c.id', 'c.body', 'c.plan_version_id', 'c.created_at', 'u.display_name as author']).where('c.plan_id', '=', id).orderBy('c.created_at').execute();
    const snapshotIds = [...new Set(versions.map((v) => v.metric_snapshot_id).filter((x): x is string => !!x))];
    const snaps = snapshotIds.length ? await trx.selectFrom('metric_snapshots').select(['id', 'data_as_of', 'period_start', 'period_end']).where('id', 'in', snapshotIds).execute() : [];
    const children = await trx.selectFrom('marketing_plans').select(['id', 'title', 'period_start', 'status']).where('parent_plan_id', '=', id).execute();
    const parent = plan.parent_plan_id ? await trx.selectFrom('marketing_plans').select(['id', 'title', 'period_start', 'status']).where('id', '=', plan.parent_plan_id).executeTakeFirst() : null;
    return {
      ...plan, parent, children, comments,
      versions: versions.map((v) => ({ ...v, data_as_of: snaps.find((s) => s.id === v.metric_snapshot_id)?.data_as_of ?? null })),
      has_unapproved_changes: !!plan.approved_version_id && plan.approved_version_id !== plan.current_version_id,
    };
  });
}

export async function createManualPlan(access: TenantAccess, actor: AuditActor, input: z.infer<typeof createPlanInput>) {
  if (input.period_end < input.period_start) throw Errors.invalid('invalid_period');
  return withTenant(access.tenantId, async (trx) => {
    if (input.kind === 'weekly') {
      if (!input.parent_plan_id) throw Errors.invalid('weekly_requires_monthly', 'A weekly plan must link to a monthly plan');
      const parent = await trx.selectFrom('marketing_plans').select(['id', 'kind']).where('id', '=', input.parent_plan_id).executeTakeFirst();
      if (!parent || parent.kind !== 'monthly') throw Errors.notFound('plan');
    }
    const plan = await trx.insertInto('marketing_plans').values({
      tenant_id: access.tenantId, kind: input.kind, parent_plan_id: input.parent_plan_id ?? null, period_start: input.period_start, period_end: input.period_end,
      title: input.title, status: 'draft', created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await appendVersion(trx, access.tenantId, plan.id, { content: input.content, source: 'manual', createdBy: actor.userId });
    await audit(trx, actor, 'marketing.plan_created', { tenantId: access.tenantId, targetType: 'marketing_plan', targetId: plan.id });
    return { id: plan.id };
  });
}

/** A labelled EXAMPLE plan for empty/new businesses or when AI is unavailable. Never presented as analysis. */
export async function createExamplePlan(access: TenantAccess, actor: AuditActor, kind: 'monthly' | 'weekly') {
  const today = localToday(access.timezone);
  const { from, to } = kind === 'monthly' ? monthBounds(today) : { from: today, to: addDays(today, 6) };
  const ex = examplePlan(access.defaultLocale, kind, from, to);
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.insertInto('marketing_plans').values({
      tenant_id: access.tenantId, kind, period_start: from, period_end: to, title: ex.title, status: 'draft', is_example: true, created_by: actor.userId,
    }).returning('id').executeTakeFirstOrThrow();
    await appendVersion(trx, access.tenantId, plan.id, { content: ex.content, source: 'example', createdBy: actor.userId, validation: { status: 'example' } });
    return { id: plan.id, is_example: true };
  });
}

export async function addPlanVersion(access: TenantAccess, actor: AuditActor, planId: string, input: z.infer<typeof planVersionInput>) {
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.selectFrom('marketing_plans').selectAll().where('id', '=', planId).forUpdate().executeTakeFirst();
    if (!plan) throw Errors.notFound('plan');
    if (plan.status === 'completed' || plan.status === 'rejected') throw Errors.conflict('plan_closed', 'Reopen the plan before editing it');
    const latest = await nextVersion(trx, planId) - 1;
    if (input.base_version !== latest) throw Errors.versionConflict(latest);
    const v = await appendVersion(trx, access.tenantId, planId, { content: input.content, source: 'manual', createdBy: actor.userId, changeNote: input.change_note ?? null, validation: { status: 'manual' } });
    if (plan.status === 'draft' || plan.status === 'deferred') await trx.updateTable('marketing_plans').set({ status: 'draft' }).where('id', '=', planId).execute();
    await audit(trx, actor, 'marketing.plan_version_added', { tenantId: access.tenantId, targetType: 'marketing_plan', targetId: planId, data: { version: v.version } });
    return { plan_id: planId, version: v.version, approved_version_unchanged: !!plan.approved_version_id };
  });
}

const TRANSITIONS: Record<(typeof PLAN_ACTIONS)[number], { from: PlanStatus[]; to: PlanStatus }> = {
  propose: { from: ['draft', 'deferred'], to: 'proposed' },
  review: { from: ['proposed', 'draft'], to: 'under_review' },
  approve: { from: ['draft', 'proposed', 'under_review', 'approved', 'in_progress'], to: 'approved' },
  start: { from: ['approved'], to: 'in_progress' },
  complete: { from: ['approved', 'in_progress'], to: 'completed' },
  defer: { from: ['draft', 'proposed', 'under_review', 'approved'], to: 'deferred' },
  reject: { from: ['draft', 'proposed', 'under_review'], to: 'rejected' },
  reopen: { from: ['deferred', 'rejected'], to: 'draft' },
};

export async function transitionPlan(access: TenantAccess, actor: AuditActor, planId: string, action: (typeof PLAN_ACTIONS)[number], note?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.selectFrom('marketing_plans').selectAll().where('id', '=', planId).forUpdate().executeTakeFirst();
    if (!plan) throw Errors.notFound('plan');
    if (plan.is_example && ['approve', 'start', 'complete', 'propose'].includes(action)) throw Errors.invalid('example_plan', 'An example plan cannot be approved or run');
    const t = TRANSITIONS[action];
    if (!t.from.includes(plan.status as PlanStatus)) throw Errors.conflict('invalid_transition', `Cannot ${action} a plan that is ${plan.status}`, { status: plan.status });
    // Approving an in-progress plan's newer version keeps it running.
    const to = action === 'approve' && plan.status === 'in_progress' ? 'in_progress' : t.to;
    const set: Record<string, unknown> = { status: to };
    if (action === 'approve') Object.assign(set, { approved_version_id: plan.current_version_id, approved_by: actor.userId, approved_at: new Date() });
    await trx.updateTable('marketing_plans').set(set).where('id', '=', planId).execute();
    await audit(trx, actor, `marketing.plan_${action}`, { tenantId: access.tenantId, targetType: 'marketing_plan', targetId: planId, data: { from: plan.status, to, note, version_id: plan.current_version_id } });
    return { id: planId, status: to };
  });
}

export async function addPlanComment(access: TenantAccess, actor: AuditActor, planId: string, body: string, versionId?: string) {
  return withTenant(access.tenantId, async (trx) => {
    const plan = await trx.selectFrom('marketing_plans').select('id').where('id', '=', planId).executeTakeFirst();
    if (!plan) throw Errors.notFound('plan');
    if (versionId) {
      const v = await trx.selectFrom('plan_versions').select('id').where('id', '=', versionId).where('plan_id', '=', planId).executeTakeFirst();
      if (!v) throw Errors.notFound('version');
    }
    return trx.insertInto('plan_comments').values({ tenant_id: access.tenantId, plan_id: planId, plan_version_id: versionId ?? null, author_id: actor.userId!, body })
      .returning(['id', 'created_at']).executeTakeFirstOrThrow();
  });
}

type Change = { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Field-level diff; arrays of objects with ids are compared by id. */
export function diffContent(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): Change[] {
  const out: Change[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    const x = a[key], y = b[key];
    if (same(x, y)) continue;
    if (x === undefined) { out.push({ path, kind: 'added', after: y }); continue; }
    if (y === undefined) { out.push({ path, kind: 'removed', before: x }); continue; }
    if (Array.isArray(x) && Array.isArray(y) && [...x, ...y].every((e) => e && typeof e === 'object' && 'id' in e)) {
      const ax = new Map(x.map((e) => [(e as { id: string }).id, e])), by = new Map(y.map((e) => [(e as { id: string }).id, e]));
      for (const [id, e] of by) if (!ax.has(id)) out.push({ path: `${path}[${id}]`, kind: 'added', after: e });
      for (const [id, e] of ax) if (!by.has(id)) out.push({ path: `${path}[${id}]`, kind: 'removed', before: e });
      for (const [id, e] of by) if (ax.has(id) && !same(ax.get(id), e)) out.push(...diffContent(ax.get(id) as Record<string, unknown>, e as Record<string, unknown>, `${path}[${id}]`));
      continue;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) { out.push(...diffContent(x as Record<string, unknown>, y as Record<string, unknown>, path)); continue; }
    out.push({ path, kind: 'changed', before: x, after: y });
  }
  return out;
}

export async function diffVersions(access: TenantAccess, planId: string, from: number, to: number) {
  return withTenant(access.tenantId, async (trx) => {
    const rows = await trx.selectFrom('plan_versions').select(['version', 'content']).where('plan_id', '=', planId).where('version', 'in', [from, to]).execute();
    const a = rows.find((r) => r.version === from), b = rows.find((r) => r.version === to);
    if (!a || !b) throw Errors.notFound('version');
    return { from, to, changes: diffContent(a.content as Record<string, unknown>, b.content as Record<string, unknown>) };
  });
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection and quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export async function exportPlan(access: TenantAccess, planId: string, format: 'json' | 'csv', version?: number) {
  const p = await getPlan(access, planId);
  const v = version ? p.versions.find((x) => x.version === version) : p.versions[0];
  if (!v) throw Errors.notFound('version');
  const content = v.content as PlanContent;
  const meta = { id: p.id, kind: p.kind, title: p.title, status: p.status, is_example: p.is_example, period_start: p.period_start, period_end: p.period_end, version: v.version, source: v.source, data_as_of: v.data_as_of, approved: p.approved_version_id === v.id };
  if (format === 'json') return { filename: `plan-${p.period_start}-v${v.version}.json`, mime: 'application/json', body: JSON.stringify({ ...meta, content }, null, 2) };
  const head = ['section', 'id', 'title', 'date_from', 'date_to', 'channel', 'detail', 'link'];
  const rows: unknown[][] = [
    ['plan', p.id, p.title, p.period_start, p.period_end, '', `${content.goal} | status=${p.status} | version=${v.version} | source=${v.source}${p.is_example ? ' | EXAMPLE' : ''}`, ''],
    ...content.initiatives.map((i) => ['initiative', i.id, i.title, '', '', '', i.description, i.evidence_refs.join(' ')]),
    ...content.activities.map((a) => ['activity', a.id, a.title, a.date_from, a.date_to, a.channel, a.content_idea, a.initiative_id ?? a.monthly_goal_ref]),
    ...content.metrics.map((m) => ['metric', m.key, m.label, '', '', '', `baseline=${m.baseline ?? ''} proposed_target=${m.proposed_target ?? ''}`, '']),
  ];
  const body = `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
  return { filename: `plan-${p.period_start}-v${v.version}.csv`, mime: 'text/csv; charset=utf-8', body };
}
