-- 0011 Rows with tenant_id NULL are platform/user-level records (auth audit
-- events, platform notifications, outbox/jobs not yet bound to a tenant).
-- Any scope may INSERT them; only system scope (or reviewed SECURITY DEFINER
-- functions) can read them back. Tenant rows keep the strict isolation policy.
do $$
declare t text;
begin
  foreach t in array array['audit_logs', 'notification_deliveries', 'notifications', 'outbox_events', 'job_runs', 'customer_consents'] loop
    execute format('create policy null_tenant_insert on public.%I for insert with check (tenant_id is null)', t);
  end loop;
end $$;
