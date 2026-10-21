import type { z } from 'zod';
import { sql, withTenant, type Tx } from '../../db/client';
import { Errors } from '../../http/errors';
import { audit, type AuditActor } from '../../infra/audit';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import type { performanceSettingsInput } from '@/shared/schemas/marketing';
import { computeOccupancy } from './occupancy';
import { resolvePeriod } from './period';

/**
 * Employee performance indicators.
 *
 * Principles:
 *  - Each indicator is computed and shown separately, with its sample size,
 *    minimum sample, uncertainty interval and method. Below the minimum the
 *    result is "insufficient data for evaluation" — never a number.
 *  - The composite score uses per-tenant weights over the indicators that have
 *    enough data, and only when the specialist has enough completed services.
 *  - Productivity is normalised by available working hours and compared only
 *    within the same specialty (main service category). Revenue is never used
 *    to compare specialties with different price levels.
 *  - Actual execution time uses actual_started_at/actual_ended_at; the catalog
 *    duration is the planned time, not elapsed time.
 *  - These indicators support coaching and resource planning. They are not a
 *    basis for dismissal, pay or employment decisions.
 */

export type Weights = { satisfaction: number; repeat: number; punctuality: number; complaints: number; occupancy: number };
export type PerfSettings = { weights: Weights; min_completed: number; min_reviews: number; min_timed: number; punctuality_grace_min: number };
export const DEFAULT_PERF_SETTINGS: PerfSettings = {
  weights: { satisfaction: 30, repeat: 20, punctuality: 20, complaints: 15, occupancy: 15 },
  min_completed: 20, min_reviews: 8, min_timed: 10, punctuality_grace_min: 10,
};

type Indicator = {
  status: 'ok' | 'insufficient_data';
  value: number | null;
  n: number;
  min_n: number;
  interval: [number, number] | null;
};

const MIN_AVAILABLE_MIN = 600; // 10 scheduled hours before occupancy is evaluated

/** Wilson score interval (95%) for a proportion. */
export function wilson(successes: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.96, p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function indicator(value: number | null, n: number, minN: number, interval: [number, number] | null = null): Indicator {
  if (n < minN || value === null) return { status: 'insufficient_data', value: null, n, min_n: minN, interval: null };
  return { status: 'ok', value, n, min_n: minN, interval };
}

export async function loadPerfSettings(trx: Tx, tenantId: string): Promise<PerfSettings> {
  const r = await trx.selectFrom('performance_settings').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!r) return DEFAULT_PERF_SETTINGS;
  return { weights: { ...DEFAULT_PERF_SETTINGS.weights, ...(r.weights as Partial<Weights>) }, min_completed: r.min_completed, min_reviews: r.min_reviews, min_timed: r.min_timed, punctuality_grace_min: r.punctuality_grace_min };
}

export async function getPerfSettings(access: TenantAccess) {
  return withTenant(access.tenantId, (trx) => loadPerfSettings(trx, access.tenantId));
}

export async function savePerfSettings(access: TenantAccess, actor: AuditActor, input: z.infer<typeof performanceSettingsInput>) {
  return withTenant(access.tenantId, async (trx) => {
    await trx.insertInto('performance_settings').values({ tenant_id: access.tenantId, ...input, weights: JSON.stringify(input.weights), updated_by: actor.userId })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet({ ...input, weights: JSON.stringify(input.weights), updated_by: actor.userId })).execute();
    await audit(trx, actor, 'analytics.performance_settings_updated', { tenantId: access.tenantId, data: input });
    return loadPerfSettings(trx, access.tenantId);
  });
}

type StaffRaw = {
  staff_id: string; display_name: string; completed: number; cancelled: number; no_show: number; customers: number; repeat_customers: number;
  timed_start: number; on_time: number; avg_delay_min: number | null; timed_both: number; avg_actual_min: number | null; avg_planned_min: number | null;
  reviews: number; avg_rating: number | null; sd_rating: number | null; complaints: number; specialty_id: string | null; specialty_ar: string | null; specialty_en: string | null;
};

async function rawIndicators(trx: Tx, tenantId: string, start: Date, end: Date, graceMin: number, staffIds: string[] | null): Promise<StaffRaw[]> {
  const r = await sql<StaffRaw>`
    with items as (
      select bi.id, bi.staff_id, bi.booking_id, bi.service_id, bi.starts_at, bi.duration_min, bi.actual_started_at, bi.actual_ended_at,
             bk.status, bk.tenant_customer_id
      from booking_items bi join bookings bk on bk.id = bi.booking_id and bk.tenant_id = bi.tenant_id
      where bi.tenant_id = ${tenantId} and bi.starts_at >= ${start} and bi.starts_at < ${end}
    ),
    per_customer as (
      select staff_id, tenant_customer_id, count(distinct booking_id) as visits from items where status = 'completed' group by 1, 2
    ),
    rev as (
      select s.id as staff_id, r.rating
      from reviews r join bookings bk on bk.id = r.booking_id and bk.tenant_id = r.tenant_id
      join staff_profiles s on s.tenant_id = r.tenant_id
      where r.tenant_id = ${tenantId} and r.status <> 'hidden' and bk.starts_at >= ${start} and bk.starts_at < ${end}
        and (r.staff_id = s.id or (r.staff_id is null and exists (select 1 from booking_items x where x.booking_id = r.booking_id and x.staff_id = s.id)))
    ),
    complaints as (
      select distinct s.staff_id, ci.id from customer_incidents ci
      join (select distinct staff_id, booking_id from items) s on s.booking_id = ci.booking_id
      where ci.tenant_id = ${tenantId} and ci.type = 'conduct' and ci.status = 'confirmed'
    ),
    specialty as (
      select distinct on (i.staff_id) i.staff_id, sv.category_id, c.name_ar, c.name_en
      from items i join services sv on sv.id = i.service_id left join categories c on c.id = sv.category_id
      where i.status = 'completed' group by i.staff_id, sv.category_id, c.name_ar, c.name_en order by i.staff_id, count(*) desc
    )
    select sp.id as staff_id, sp.display_name,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'completed')::int as completed,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'cancelled')::int as cancelled,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'no_show')::int as no_show,
      (select count(*) from per_customer pc where pc.staff_id = sp.id)::int as customers,
      (select count(*) from per_customer pc where pc.staff_id = sp.id and pc.visits >= 2)::int as repeat_customers,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null)::int as timed_start,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null
         and i.actual_started_at <= i.starts_at + make_interval(mins => ${graceMin}))::int as on_time,
      (select avg(greatest(0, extract(epoch from (i.actual_started_at - i.starts_at)) / 60)) from items i
         where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null)::float8 as avg_delay_min,
      (select count(*) from items i where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null and i.actual_ended_at > i.actual_started_at)::int as timed_both,
      (select avg(extract(epoch from (i.actual_ended_at - i.actual_started_at)) / 60) from items i
         where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null and i.actual_ended_at > i.actual_started_at)::float8 as avg_actual_min,
      (select avg(i.duration_min) from items i
         where i.staff_id = sp.id and i.status = 'completed' and i.actual_started_at is not null and i.actual_ended_at > i.actual_started_at)::float8 as avg_planned_min,
      (select count(*) from rev where rev.staff_id = sp.id)::int as reviews,
      (select avg(rating) from rev where rev.staff_id = sp.id)::float8 as avg_rating,
      (select stddev_samp(rating) from rev where rev.staff_id = sp.id)::float8 as sd_rating,
      (select count(*) from complaints c where c.staff_id = sp.id)::int as complaints,
      spc.category_id as specialty_id, spc.name_ar as specialty_ar, spc.name_en as specialty_en
    from staff_profiles sp left join specialty spc on spc.staff_id = sp.id
    where sp.tenant_id = ${tenantId} and sp.archived_at is null
      ${staffIds ? sql`and sp.id = any(${staffIds}::uuid[])` : sql``}
    order by sp.sort, sp.created_at`.execute(trx);
  return r.rows;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function evaluate(raw: StaffRaw, occ: { available_min: number; booked_min: number; occupancy: number | null } | undefined, st: PerfSettings) {
  const satCi = raw.avg_rating !== null && raw.reviews > 1 && raw.sd_rating !== null
    ? [Math.max(1, raw.avg_rating - (1.96 * raw.sd_rating) / Math.sqrt(raw.reviews)), Math.min(5, raw.avg_rating + (1.96 * raw.sd_rating) / Math.sqrt(raw.reviews))] as [number, number]
    : null;
  const minCustomers = Math.max(5, Math.floor(st.min_completed / 2));
  const availableH = (occ?.available_min ?? 0) / 60;
  const indicators = {
    satisfaction: indicator(raw.avg_rating, raw.reviews, st.min_reviews, satCi),
    review_count: { status: 'ok' as const, value: raw.reviews, n: raw.reviews, min_n: 0, interval: null },
    repeat_rate: indicator(raw.customers ? raw.repeat_customers / raw.customers : null, raw.customers, minCustomers, wilson(raw.repeat_customers, raw.customers)),
    punctuality: indicator(raw.timed_start ? raw.on_time / raw.timed_start : null, raw.timed_start, st.min_timed, wilson(raw.on_time, raw.timed_start)),
    avg_start_delay_min: indicator(raw.avg_delay_min, raw.timed_start, st.min_timed),
    execution_ratio: indicator(raw.avg_actual_min !== null && raw.avg_planned_min ? raw.avg_actual_min / raw.avg_planned_min : null, raw.timed_both, st.min_timed),
    complaint_rate: indicator(raw.completed ? raw.complaints / raw.completed : null, raw.completed, st.min_completed, wilson(raw.complaints, raw.completed)),
    occupancy: indicator(occ?.occupancy ?? null, Math.round(occ?.available_min ?? 0), MIN_AVAILABLE_MIN),
    completed_per_available_hour: indicator(availableH > 0 ? raw.completed / availableH : null, Math.round(occ?.available_min ?? 0), MIN_AVAILABLE_MIN),
  };
  const parts: Array<{ key: keyof Weights; score: number }> = [];
  if (indicators.satisfaction.status === 'ok') parts.push({ key: 'satisfaction', score: (indicators.satisfaction.value! - 1) / 4 });
  if (indicators.repeat_rate.status === 'ok') parts.push({ key: 'repeat', score: indicators.repeat_rate.value! });
  if (indicators.punctuality.status === 'ok') parts.push({ key: 'punctuality', score: indicators.punctuality.value! });
  if (indicators.complaint_rate.status === 'ok') parts.push({ key: 'complaints', score: Math.max(0, 1 - indicators.complaint_rate.value! * 10) });
  if (indicators.occupancy.status === 'ok') parts.push({ key: 'occupancy', score: Math.min(1, indicators.occupancy.value!) });
  const used = parts.filter((p) => st.weights[p.key] > 0);
  const wsum = used.reduce((m, p) => m + st.weights[p.key], 0);
  const enough = raw.completed >= st.min_completed && used.length >= 3 && wsum > 0;
  const composite = enough
    ? { status: 'ok' as const, score: Math.round((used.reduce((m, p) => m + p.score * st.weights[p.key], 0) / wsum) * 100), components: used.map((p) => ({ key: p.key, score: Math.round(p.score * 100), weight: st.weights[p.key] })) }
    : { status: 'insufficient_data' as const, score: null, components: used.map((p) => ({ key: p.key, score: Math.round(p.score * 100), weight: st.weights[p.key] })), reason: raw.completed < st.min_completed ? 'min_completed' : 'too_few_indicators' };
  return { indicators, composite };
}

/**
 * Team indicators for a period. Requires analytics.view; a specialist (or any
 * member without analytics.view) only ever sees her own row.
 */
export async function teamPerformance(access: TenantAccess, q: { from?: string; to?: string }) {
  const seeAll = hasCapability(access, 'analytics.view') && access.role !== 'specialist';
  if (!seeAll && !access.staffProfileId) throw Errors.forbidden();
  const period = resolvePeriod(access.timezone, q.from, q.to, 90);
  const scope = seeAll ? null : [access.staffProfileId!];
  return withTenant(access.tenantId, async (trx) => {
    const st = await loadPerfSettings(trx, access.tenantId);
    const raw = await rawIndicators(trx, access.tenantId, period.start, period.end, st.punctuality_grace_min, seeAll ? null : scope);
    // Peer comparison needs everyone in the specialty even when only one row is shown.
    const peersRaw = seeAll ? raw : await rawIndicators(trx, access.tenantId, period.start, period.end, st.punctuality_grace_min, null);
    const occ = await computeOccupancy(trx, access.tenantId, access.timezone, period.from, period.to);
    const occById = new Map(occ.staff.map((s) => [s.staff_id, s]));
    const evaluated = peersRaw.map((r) => ({ raw: r, ev: evaluate(r, occById.get(r.staff_id), st) }));
    const bySpecialty = new Map<string, number[]>();
    for (const e of evaluated) {
      const p = e.ev.indicators.completed_per_available_hour;
      if (p.status === 'ok' && e.raw.specialty_id) bySpecialty.set(e.raw.specialty_id, [...(bySpecialty.get(e.raw.specialty_id) ?? []), p.value!]);
    }
    const shown = new Set(raw.map((r) => r.staff_id));
    return {
      period: { from: period.from, to: period.to, timezone: period.timezone },
      settings: st,
      scope: seeAll ? 'team' : 'self',
      staff: evaluated.filter((e) => shown.has(e.raw.staff_id)).map(({ raw: r, ev }) => {
        const peers = r.specialty_id ? bySpecialty.get(r.specialty_id) ?? [] : [];
        const med = peers.length >= 2 ? median(peers) : null;
        const prod = ev.indicators.completed_per_available_hour;
        return {
          staff_id: r.staff_id,
          display_name: r.display_name,
          specialty: r.specialty_id ? { id: r.specialty_id, name_ar: r.specialty_ar, name_en: r.specialty_en } : null,
          counts: { completed: r.completed, cancelled: r.cancelled, no_show: r.no_show, customers: r.customers, reviews: r.reviews, complaints_confirmed: r.complaints },
          execution: { avg_actual_min: r.avg_actual_min, avg_planned_min: r.avg_planned_min, timed_services: r.timed_both },
          indicators: ev.indicators,
          productivity_vs_specialty: prod.status === 'ok' && med ? { index: prod.value! / med, peers: peers.length } : { index: null, peers: peers.length, reason: 'not_enough_peers_in_specialty' },
          composite: ev.composite,
          occupancy_min: occById.get(r.staff_id) ? { available: occById.get(r.staff_id)!.available_min, booked: occById.get(r.staff_id)!.booked_min } : null,
        };
      }),
      method: {
        satisfaction: 'reviews_linked_by_booking_or_staff',
        repeat_rate: 'customers_with_2plus_completed_visits_with_staff',
        punctuality: 'actual_start_within_grace',
        complaints: 'confirmed_conduct_incidents_on_staff_bookings',
        productivity: 'completed_per_available_hour_within_specialty',
        execution: 'actual_end_minus_actual_start',
        composite: 'weighted_mean_of_sufficient_indicators',
        uncertainty: 'wilson_95_or_mean_ci',
      },
      correction_route: 'correct_booking_times_attendance_reviews',
      usage_note: 'coaching_not_employment_decisions',
    };
  });
}

/** Evaluated indicators for every specialist (internal; callers must strip names before any AI use). */
export async function evaluatedTeam(trx: Tx, tenantId: string, tz: string, from: string, to: string) {
  const st = await loadPerfSettings(trx, tenantId);
  const p = resolvePeriod(tz, from, to);
  const raw = await rawIndicators(trx, tenantId, p.start, p.end, st.punctuality_grace_min, null);
  const occ = await computeOccupancy(trx, tenantId, tz, p.from, p.to);
  const occById = new Map(occ.staff.map((s) => [s.staff_id, s]));
  return raw.map((r) => ({ staff_id: r.staff_id, specialty_id: r.specialty_id, completed: r.completed, ev: evaluate(r, occById.get(r.staff_id), st) }));
}
