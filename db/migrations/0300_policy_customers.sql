-- ════════════════════════════════════════════════════════════════════════════
-- 0300 Customers (CRM), incidents, policy decisions, appeals, reviews:
--      lifecycle columns needed by the policy and customer services.
--
--   * Decisions record who ended them and why (revoked / expired / superseded),
--     and when a review_at date was flagged to reviewers.
--   * Incidents carry an explicit platform-escalation state. Escalating never
--     creates a platform decision by itself; a platform reviewer decides.
--   * Appeals are routed to the scope that owns the appealed item.
--   * Reviews keep moderation and reply metadata (reviews are never deleted).
-- ════════════════════════════════════════════════════════════════════════════

alter table tenant_customers
  add column version int not null default 1,
  add column archived_at timestamptz;
create index tenant_customers_name_idx on tenant_customers (tenant_id, lower(display_name));

alter table policy_decisions
  add column ended_at timestamptz,
  add column ended_by uuid references users(id),
  add column end_reason text,
  add column review_flagged_at timestamptz,
  add column source_incident_id uuid references customer_incidents(id),
  add check (status = 'active' or ended_at is not null);
create index policy_decisions_expiry_idx on policy_decisions (expires_at) where status = 'active' and expires_at is not null;
create index policy_decisions_review_idx on policy_decisions (review_at) where status = 'active' and review_at is not null and review_flagged_at is null;
-- A decision can be superseded by at most one newer decision.
create unique index policy_decisions_supersedes_once on policy_decisions (supersedes_id) where supersedes_id is not null;

alter table customer_incidents
  add column escalation_status text check (escalation_status in ('pending', 'decided', 'dismissed')),
  add column escalation_note text,
  add column escalated_by uuid references users(id),
  add column platform_reviewed_by uuid references users(id),
  add column platform_reviewed_at timestamptz,
  add check ((escalated_to_platform_at is null) = (escalation_status is null));
create index customer_incidents_escalation_idx on customer_incidents (escalation_status, escalated_to_platform_at) where escalation_status is not null;
create index customer_incidents_customer_idx on customer_incidents (tenant_id, tenant_customer_id, status);
create index customer_incidents_user_idx on customer_incidents (customer_user_id) where customer_user_id is not null;

alter table appeals
  add column review_scope text not null default 'tenant' check (review_scope in ('tenant', 'platform')),
  add check ((review_scope = 'tenant') = (tenant_id is not null));
create index appeals_tenant_idx on appeals (tenant_id, status, created_at desc);
create index appeals_customer_idx on appeals (customer_user_id, created_at desc);

alter table policy_rules
  add column description text check (description is null or length(description) <= 500),
  add column updated_by uuid references users(id);

alter table reviews
  add column customer_user_id uuid references users(id),
  add column moderation_reason text,
  add column moderated_by uuid references users(id),
  add column moderated_at timestamptz,
  add column replied_by uuid references users(id),
  add column replied_at timestamptz,
  add check (status = 'published' or moderation_reason is not null);
create index reviews_tenant_status_idx on reviews (tenant_id, status, created_at desc);

-- Completed visits of one customer that she has not reviewed yet (central
-- account). Allowlisted columns only; never other customers' data.
create or replace function app.customer_reviewable_bookings(p_user uuid, p_limit int)
returns table (id uuid, tenant_id uuid, tenant_slug text, tenant_name text, number text, starts_at timestamptz, timezone text, items jsonb)
language sql stable security definer set search_path = public as $$
  select b.id, b.tenant_id, t.slug::text, t.name, b.number, b.starts_at, b.timezone,
         coalesce((select jsonb_agg(jsonb_build_object('service_name_ar', i.service_name_ar, 'service_name_en', i.service_name_en,
                   'staff_name', i.staff_name) order by i.sequence) from booking_items i where i.booking_id = b.id), '[]'::jsonb)
  from bookings b join tenants t on t.id = b.tenant_id
  where b.customer_user_id = p_user and b.status = 'completed'
    and not exists (select 1 from reviews r where r.tenant_id = b.tenant_id and r.booking_id = b.id)
  order by b.starts_at desc
  limit least(p_limit, 100)
$$;

select app.apply_conventions('{{APP_ROLE}}');
grant execute on function app.customer_reviewable_bookings(uuid, int) to {{APP_ROLE}};
