-- 0024 A platform policy reviewer may view evidence ONLY for incidents the
-- business escalated to LUMA. This definer function answers that one question
-- without exposing any other tenant data.
create or replace function app.evidence_escalated(p_asset uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from incident_evidence e
    join customer_incidents i on i.tenant_id = e.tenant_id and i.id = e.incident_id
    where e.asset_id = p_asset and i.escalated_to_platform_at is not null
  )
$$;
revoke all on function app.evidence_escalated(uuid) from public;
grant execute on function app.evidence_escalated(uuid) to {{APP_ROLE}};
