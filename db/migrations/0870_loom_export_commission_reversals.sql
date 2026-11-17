-- Loom export: platform fees net of marketplace commission reversals.
--
-- loom_export.transactions (0700) summed marketplace_commissions.fee_minor
-- only, so a booking refunded after completion still reported the full
-- marketplace fee although 0830 reverses it proportionally (owner decision R1)
-- in marketplace_commission_reversals. The view now reports the fee kept:
-- charged minus reversed, never below zero. Same columns, same order.
create or replace view loom_export.transactions with (security_invoker = true) as
  select bk.id, 'booking'::text as kind, bk.status as source_status, bk.cancel_source,
         bk.channel, bk.source as origin, loom_export.pseudo(bk.tenant_customer_id) as customer_ref,
         bk.subtotal_minor, bk.discount_minor, bk.tax_minor, bk.total_minor, bk.refunded_minor,
         bk.starts_at as occurred_at, bk.campaign_id, bk.marketplace_fee_bp, bk.coupon_id is not null as has_coupon,
         greatest(0,
           (select coalesce(sum(mc.fee_minor), 0) from marketplace_commissions mc where mc.booking_id = bk.id and mc.tenant_id = bk.tenant_id)
           - (select coalesce(sum(r.fee_reversed_minor), 0) from marketplace_commission_reversals r where r.booking_id = bk.id and r.tenant_id = bk.tenant_id)
         )::bigint as platform_fee_minor,
         bk.updated_at
    from bookings bk where bk.tenant_id = app.current_tenant() and bk.starts_at > now() - interval '730 days'
  union all
  select o.id, 'order', o.status, case when o.cancelled_by is not null and o.cancelled_by = o.customer_user_id then 'customer' when o.status = 'cancelled' then 'business' end,
         'direct', 'order', loom_export.pseudo(o.tenant_customer_id),
         o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor, o.refunded_minor,
         o.created_at, o.campaign_id, null::int, o.coupon_id is not null, 0::bigint, o.updated_at
    from orders o where o.tenant_id = app.current_tenant() and o.created_at > now() - interval '730 days';
