import { DateTime } from 'luxon';
import { sql, withTenant, type Tx } from '../../db/client';
import { hasCapability, type TenantAccess } from '../../tenancy/access';
import { computeOccupancy } from '../analytics/occupancy';
import { addDays, dateRange, localToday } from '../analytics/period';
import { staffInBranches } from './branch-scope';

/**
 * Workspace overview (/app/{slug}). Every figure respects the viewer's
 * capabilities: money only with bookings.view_financial or finance.view;
 * bookings for everyone only with bookings.view_all/manage (a specialist sees
 * her own); the team, occupancy, reviews and plan usage only with the matching
 * capability. Missing sections are `null` (not zero) so the UI hides them.
 *
 * Branch-aware through the switcher (bookings by branch, staff by assignment).
 * Independent experts (business_type 'expert') get a personal variant.
 */
export const ACTIVE_TODAY = ['pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service', 'completed', 'no_show'] as const;
const EXPECTED_REVENUE = ['pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service', 'completed'] as const;
const UPCOMING = ['pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service'] as const;

export type OverviewPerms = { money: boolean; allBookings: boolean; ownBookings: boolean; team: boolean; occupancy: boolean; reviews: boolean; plan: boolean };

export function overviewPerms(access: TenantAccess): OverviewPerms {
  const allBookings = hasCapability(access, ['bookings.view_all', 'bookings.manage']);
  return {
    money: hasCapability(access, ['bookings.view_financial', 'finance.view']),
    allBookings,
    ownBookings: !allBookings && hasCapability(access, ['bookings.view_assigned', 'bookings.manage_assigned', 'schedule.view_own']) && !!access.staffProfileId,
    team: allBookings || hasCapability(access, ['schedule.manage', 'staff.edit', 'team.manage']),
    occupancy: hasCapability(access, ['analytics.view', 'bookings.view_all', 'schedule.manage']),
    reviews: hasCapability(access, 'customers.view'),
    plan: hasCapability(access, ['subscription.view', 'business.manage']),
  };
}

type Scope = { branchIds: string[] | null; staffId: string | null };

function dayBounds(date: string, tz: string) {
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** `b.` bookings filters for branch and own-only scope. */
function bookingScope(s: Scope) {
  const parts = [sql`true`];
  if (s.branchIds) parts.push(s.branchIds.length ? sql`b.branch_id = any(${s.branchIds}::uuid[])` : sql`false`);
  if (s.staffId) parts.push(sql`exists (select 1 from booking_items i where i.booking_id = b.id and i.superseded_at is null and i.staff_id = ${s.staffId})`);
  return sql.join(parts, sql` and `);
}

async function todayBookings(trx: Tx, tenantId: string, tz: string, today: string, s: Scope) {
  const { start, end } = dayBounds(today, tz);
  const r = await sql<{ status: string; n: number; v: number }>`
    select b.status, count(*)::int as n, coalesce(sum(b.total_minor), 0)::bigint as v from bookings b
    where b.tenant_id = ${tenantId} and b.starts_at >= ${start} and b.starts_at < ${end}
      and b.status = any(${[...ACTIVE_TODAY]}::text[]) and ${bookingScope(s)}
    group by b.status`.execute(trx);
  const byStatus = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  return {
    count: r.rows.reduce((a, x) => a + x.n, 0),
    by_status: byStatus as Record<string, number>,
    expected_revenue_minor: r.rows.filter((x) => (EXPECTED_REVENUE as readonly string[]).includes(x.status)).reduce((a, x) => a + Number(x.v), 0),
  };
}

async function series(trx: Tx, tenantId: string, tz: string, today: string, s: Scope, money: boolean) {
  const from = addDays(today, -6);
  const start = dayBounds(from, tz).start, end = dayBounds(today, tz).end;
  const b = await sql<{ day: string; n: number }>`
    select to_char(b.starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, count(*)::int as n from bookings b
    where b.tenant_id = ${tenantId} and b.starts_at >= ${start} and b.starts_at < ${end}
      and b.status in ('confirmed', 'checked_in', 'in_service', 'completed', 'no_show', 'pending_approval', 'pending_payment') and ${bookingScope(s)}
    group by 1`.execute(trx);
  let sales: Array<{ day: string; v: number }> = [];
  if (money) {
    const branchFilter = s.branchIds ? (s.branchIds.length ? sql`coalesce(b.branch_id, o.branch_id) = any(${s.branchIds}::uuid[])` : sql`false`) : sql`true`;
    const own = s.staffId ? sql`exists (select 1 from booking_items i where i.booking_id = b.id and i.superseded_at is null and i.staff_id = ${s.staffId})` : sql`true`;
    sales = (await sql<{ day: string; v: number }>`
      select to_char(p.captured_at at time zone ${tz}, 'YYYY-MM-DD') as day, coalesce(sum(p.amount_minor), 0)::bigint as v
      from payments p left join bookings b on b.id = p.booking_id left join orders o on o.id = p.order_id
      where p.tenant_id = ${tenantId} and p.status = 'captured' and p.captured_at >= ${start} and p.captured_at < ${end}
        and ${branchFilter} and ${own}
      group by 1`.execute(trx)).rows;
  }
  return dateRange(from, today).map((date) => ({
    date, bookings: b.rows.find((x) => x.day === date)?.n ?? 0,
    ...(money ? { sales_minor: Number(sales.find((x) => x.day === date)?.v ?? 0) } : {}),
  }));
}

async function nextAppointments(trx: Tx, tenantId: string, s: Scope, money: boolean, now: Date, limit = 6) {
  const r = await sql<{ id: string; number: string; status: string; starts_at: Date; ends_at: Date; timezone: string; branch_id: string; total_minor: number; customer_name: string; services: string | null; staff_names: string | null }>`
    select b.id, b.number, b.status, b.starts_at, b.ends_at, b.timezone, b.branch_id, b.total_minor, c.display_name as customer_name,
      (select string_agg(coalesce(i.service_name_ar, i.service_name_en), ' + ' order by i.sequence) from booking_items i where i.booking_id = b.id and i.superseded_at is null) as services,
      (select string_agg(distinct i.staff_name, '، ') from booking_items i where i.booking_id = b.id and i.superseded_at is null) as staff_names
    from bookings b join tenant_customers c on c.id = b.tenant_customer_id
    where b.tenant_id = ${tenantId} and b.ends_at > ${now} and b.status = any(${[...UPCOMING]}::text[]) and ${bookingScope(s)}
    order by b.starts_at, b.id limit ${limit}`.execute(trx);
  return r.rows.map(({ total_minor, ...x }) => ({ ...x, ...(money ? { total_minor } : {}) }));
}

async function todaysAppointments(trx: Tx, tenantId: string, tz: string, today: string, s: Scope, money: boolean) {
  const { start, end } = dayBounds(today, tz);
  const r = await sql<{ id: string; number: string; status: string; starts_at: Date; ends_at: Date; timezone: string; branch_id: string; total_minor: number; customer_name: string; services: string | null; staff_names: string | null }>`
    select b.id, b.number, b.status, b.starts_at, b.ends_at, b.timezone, b.branch_id, b.total_minor, c.display_name as customer_name,
      (select string_agg(coalesce(i.service_name_ar, i.service_name_en), ' + ' order by i.sequence) from booking_items i where i.booking_id = b.id and i.superseded_at is null) as services,
      (select string_agg(distinct i.staff_name, '، ') from booking_items i where i.booking_id = b.id and i.superseded_at is null) as staff_names
    from bookings b join tenant_customers c on c.id = b.tenant_customer_id
    where b.tenant_id = ${tenantId} and b.starts_at >= ${start} and b.starts_at < ${end} and b.status = any(${[...ACTIVE_TODAY]}::text[]) and ${bookingScope(s)}
    order by b.starts_at, b.id limit 30`.execute(trx);
  return r.rows.map(({ total_minor, ...x }) => ({ ...x, ...(money ? { total_minor } : {}) }));
}

async function latestReviews(trx: Tx, tenantId: string, s: Scope, limit = 4) {
  const r = await sql<{ id: string; rating: number; comment: string | null; created_at: Date; customer_name: string; staff_name: string | null; business_reply: string | null }>`
    select r.id, r.rating, r.comment, r.created_at, c.display_name as customer_name, sp.display_name as staff_name, r.business_reply
    from reviews r join tenant_customers c on c.id = r.tenant_customer_id join bookings b on b.id = r.booking_id
    left join staff_profiles sp on sp.id = r.staff_id
    where r.tenant_id = ${tenantId} and r.status = 'published' and ${bookingScope({ branchIds: s.branchIds, staffId: null })}
      ${s.staffId ? sql`and (r.staff_id = ${s.staffId} or exists (select 1 from booking_items i where i.booking_id = b.id and i.staff_id = ${s.staffId}))` : sql``}
    order by r.created_at desc limit ${limit}`.execute(trx);
  const avg = await sql<{ avg: number | null; n: number }>`
    select avg(r.rating)::float as avg, count(*)::int as n from reviews r join bookings b on b.id = r.booking_id
    where r.tenant_id = ${tenantId} and r.status = 'published' and ${bookingScope({ branchIds: s.branchIds, staffId: null })}
      ${s.staffId ? sql`and r.staff_id = ${s.staffId}` : sql``}`.execute(trx);
  // First name only for customers (privacy, as on the storefront).
  return {
    average: avg.rows[0]?.avg ?? null, count: avg.rows[0]?.n ?? 0,
    items: r.rows.map((x) => ({ ...x, customer_name: x.customer_name.trim().split(/\s+/)[0] ?? '' })),
  };
}

async function staffToday(trx: Tx, access: TenantAccess, today: string, s: Scope) {
  const staffIds = await staffInBranches(trx, s.branchIds);
  if (staffIds && !staffIds.length) return { on_duty: 0, total: 0, occupancy: null, staff: [] };
  const occ = await computeOccupancy(trx, access.tenantId, access.timezone, today, today, { staffIds: staffIds ?? undefined });
  const { start, end } = dayBounds(today, access.timezone);
  const counts = await sql<{ staff_id: string; n: number; next_at: Date | null }>`
    select i.staff_id, count(distinct b.id)::int as n, min(i.starts_at) filter (where i.ends_at > now()) as next_at
    from booking_items i join bookings b on b.id = i.booking_id
    where i.tenant_id = ${access.tenantId} and i.superseded_at is null and i.starts_at >= ${start} and i.starts_at < ${end}
      and b.status = any(${[...EXPECTED_REVENUE]}::text[]) and ${bookingScope({ branchIds: s.branchIds, staffId: null })}
    group by i.staff_id`.execute(trx);
  const staff = occ.staff.map((x) => ({
    staff_id: x.staff_id, display_name: x.display_name, on_duty: x.available_min > 0, available_min: x.available_min, booked_min: x.booked_min,
    occupancy: x.occupancy, bookings: counts.rows.find((c) => c.staff_id === x.staff_id)?.n ?? 0,
    next_at: counts.rows.find((c) => c.staff_id === x.staff_id)?.next_at ?? null,
  })).filter((x) => x.on_duty || x.bookings > 0).sort((a, b) => Number(b.on_duty) - Number(a.on_duty) || b.bookings - a.bookings);
  return { on_duty: staff.filter((x) => x.on_duty).length, total: occ.staff.length, occupancy: occ.totals.occupancy, booked_min: occ.totals.booked_min, available_min: occ.totals.available_min, staff };
}

async function planUsage(trx: Tx, access: TenantAccess) {
  const keys = ['limit.services', 'limit.staff', 'limit.branches', 'limit.products'] as const;
  const counts = await sql<{ services: number; staff: number; branches: number; products: number }>`
    select (select count(*) from services where tenant_id = ${access.tenantId} and archived_at is null)::int as services,
           (select count(*) from staff_profiles where tenant_id = ${access.tenantId} and archived_at is null)::int as staff,
           (select count(*) from branches where tenant_id = ${access.tenantId} and status = 'active')::int as branches,
           (select count(*) from products where tenant_id = ${access.tenantId} and status <> 'archived')::int as products`.execute(trx);
  const c = counts.rows[0]!;
  const used: Record<(typeof keys)[number], number> = { 'limit.services': c.services, 'limit.staff': c.staff, 'limit.branches': c.branches, 'limit.products': c.products };
  const items = keys.flatMap((k) => {
    const f = access.plan.features.get(k);
    if (!f?.enabled) return [];
    const ratio = f.limit ? used[k] / f.limit : null;
    return [{ key: k, used: used[k], limit: f.limit, ratio, near_limit: ratio !== null && ratio >= 0.8 }];
  });
  return { plan_code: access.plan.planCode, status: access.plan.subscriptionStatus, items, nudge: items.some((i) => i.near_limit) };
}

/** Profile completion for an independent expert's public presence. */
async function profileCompletion(trx: Tx, access: TenantAccess) {
  const sp = access.staffProfileId
    ? await trx.selectFrom('staff_profiles').select(['photo_asset_id', 'bio_ar', 'bio_en', 'title_ar', 'title_en']).where('id', '=', access.staffProfileId).executeTakeFirst()
    : undefined;
  const brand = await trx.selectFrom('brand_settings').select('logo_asset_id').where('tenant_id', '=', access.tenantId).executeTakeFirst();
  const settings = await trx.selectFrom('tenant_settings').select(['contact_phone', 'contact_whatsapp', 'booking_policy_confirmed_at']).where('tenant_id', '=', access.tenantId).executeTakeFirst();
  const n = await sql<{ services: number; hours: number }>`
    select (select count(*) from services where tenant_id = ${access.tenantId} and archived_at is null and is_active)::int as services,
           (select count(*) from working_hours where tenant_id = ${access.tenantId} ${access.staffProfileId ? sql`and staff_id = ${access.staffProfileId}` : sql``})::int as hours`.execute(trx);
  const t = await trx.selectFrom('tenants').select(['published_version_id']).where('id', '=', access.tenantId).executeTakeFirst();
  const slug = access.slug;
  const items = [
    { key: 'photo', ok: !!sp?.photo_asset_id, action_path: `/app/${slug}/me` },
    { key: 'bio', ok: !!(sp?.bio_ar || sp?.bio_en), action_path: `/app/${slug}/me` },
    { key: 'title', ok: !!(sp?.title_ar || sp?.title_en), action_path: `/app/${slug}/me` },
    { key: 'logo', ok: !!brand?.logo_asset_id, action_path: `/app/${slug}/builder` },
    { key: 'services', ok: (n.rows[0]?.services ?? 0) > 0, action_path: `/app/${slug}/services` },
    { key: 'hours', ok: (n.rows[0]?.hours ?? 0) > 0, action_path: `/app/${slug}/me` },
    { key: 'contact', ok: !!(settings?.contact_phone || settings?.contact_whatsapp), action_path: `/app/${slug}/settings?tab=profile` },
    { key: 'policy', ok: !!settings?.booking_policy_confirmed_at, action_path: `/app/${slug}/settings?tab=booking` },
    { key: 'published', ok: !!t?.published_version_id, action_path: `/app/${slug}/builder` },
  ];
  return { percent: Math.round((items.filter((i) => i.ok).length / items.length) * 100), items };
}

async function myEarningsThisMonth(trx: Tx, access: TenantAccess, today: string) {
  if (!access.staffProfileId) return null;
  const monthStart = DateTime.fromISO(today, { zone: access.timezone }).startOf('month');
  const r = await sql<{ v: number; n: number }>`
    select coalesce(sum(i.line_total_minor), 0)::bigint as v, count(distinct b.id)::int as n from booking_items i join bookings b on b.id = i.booking_id
    where i.tenant_id = ${access.tenantId} and i.staff_id = ${access.staffProfileId} and i.superseded_at is null and b.status = 'completed'
      and i.starts_at >= ${monthStart.toJSDate()} and i.starts_at < ${monthStart.plus({ months: 1 }).toJSDate()}`.execute(trx);
  return { amount_minor: Number(r.rows[0]?.v ?? 0), completed: r.rows[0]?.n ?? 0, month: monthStart.toFormat('yyyy-MM'), basis: 'completed_service_lines' };
}

export async function businessOverview(access: TenantAccess, opts: { branchIds: string[] | null; now?: Date; userName?: string }) {
  const perms = overviewPerms(access);
  const now = opts.now ?? new Date();
  const today = localToday(access.timezone, now);
  const expert = access.businessType === 'expert';
  return withTenant(access.tenantId, async (trx) => {
    const brand = await trx.selectFrom('brand_settings').select('logo_asset_id').where('tenant_id', '=', access.tenantId).executeTakeFirst();
    const store = { path: `/s/${access.slug}`, live: access.status === 'active', logo_asset_id: brand?.logo_asset_id ?? null };
    const canBookings = perms.allBookings || perms.ownBookings;
    const scope: Scope = { branchIds: opts.branchIds, staffId: perms.allBookings ? null : access.staffProfileId };
    if (expert) {
      // Personal workspace: "my" figures are the owner's own staff profile.
      const mine: Scope = { branchIds: opts.branchIds, staffId: access.staffProfileId };
      const [today_, todays, nextUp, reviews, completion, earnings, week] = await Promise.all([
        canBookings ? todayBookings(trx, access.tenantId, access.timezone, today, mine) : null,
        canBookings ? todaysAppointments(trx, access.tenantId, access.timezone, today, mine, perms.money) : null,
        canBookings ? nextAppointments(trx, access.tenantId, mine, perms.money, now, 8) : null,
        perms.reviews || access.role === 'owner' ? latestReviews(trx, access.tenantId, { branchIds: opts.branchIds, staffId: null }) : null,
        profileCompletion(trx, access),
        perms.money ? myEarningsThisMonth(trx, access, today) : null,
        canBookings ? series(trx, access.tenantId, access.timezone, today, mine, perms.money) : null,
      ]);
      return {
        variant: 'expert' as const, store, date: today, timezone: access.timezone, greeting_name: opts.userName ?? null, perms,
        today: today_ ? { bookings: today_.count, by_status: today_.by_status, ...(perms.money ? { expected_revenue_minor: today_.expected_revenue_minor } : {}) } : null,
        my_appointments_today: todays,
        next_appointments: nextUp,
        earnings_month: earnings,
        profile_completion: completion,
        latest_reviews: reviews,
        series: week,
        plan_usage: perms.plan ? await planUsage(trx, access) : null,
      };
    }
    const [t, week, nextUp, team, reviews, plan] = await Promise.all([
      canBookings ? todayBookings(trx, access.tenantId, access.timezone, today, scope) : null,
      canBookings ? series(trx, access.tenantId, access.timezone, today, scope, perms.money) : null,
      canBookings ? nextAppointments(trx, access.tenantId, scope, perms.money, now) : null,
      perms.team || perms.occupancy ? staffToday(trx, access, today, scope) : null,
      perms.reviews ? latestReviews(trx, access.tenantId, scope) : null,
      perms.plan ? planUsage(trx, access) : null,
    ]);
    return {
      variant: 'business' as const, store, date: today, timezone: access.timezone, greeting_name: opts.userName ?? null, perms,
      kpis: {
        bookings_today: t ? t.count : null,
        bookings_by_status: t ? t.by_status : null,
        expected_revenue_today_minor: t && perms.money ? t.expected_revenue_minor : null,
        staff_on_duty: team && perms.team ? { on_duty: team.on_duty, total: team.total } : null,
        occupancy_today: team && perms.occupancy ? team.occupancy : null,
      },
      series: week,
      next_appointments: nextUp,
      staff_today: team && perms.team ? team.staff : null,
      latest_reviews: reviews,
      plan_usage: plan,
    };
  });
}

export type BusinessOverview = Awaited<ReturnType<typeof businessOverview>>;
