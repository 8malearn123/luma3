-- 0801 Plan features for multi-location inventory and purchasing (D12).
-- مقترح — غير معتمد: proposed distribution for review; the LUMA owner edits it
-- in /platform/plans. Inserted only if absent; never overwrites edits.
-- A downgrade never deletes inventory data: over-limit locations stay, only
-- creating more is blocked (requireWithinLimit), and gated features become
-- unavailable until the plan allows them again.
--
--   limit.stock_locations            additional locations beyond each branch's default one
--   feature.inventory_transfers      transfers between locations
--   feature.inventory_counts         physical counts (الجرد)
--   feature.purchasing               suppliers, receipts, supplier invoices, payments
--   feature.inventory_finance_link   inventory/AP figures in finance reports
--   feature.inventory_reports_advanced consumption, expected vs actual, waste, matching reports
with matrix(code, feature_key, enabled, limit_value) as (values
  -- مقترح — غير معتمد
  ('sanaa', 'limit.stock_locations', true, 0), ('sanaa', 'feature.inventory_transfers', false, null), ('sanaa', 'feature.inventory_counts', false, null),
  ('sanaa', 'feature.purchasing', false, null), ('sanaa', 'feature.inventory_finance_link', false, null), ('sanaa', 'feature.inventory_reports_advanced', false, null),
  -- مقترح — غير معتمد
  ('wahaj', 'limit.stock_locations', true, 10), ('wahaj', 'feature.inventory_transfers', true, null), ('wahaj', 'feature.inventory_counts', true, null),
  ('wahaj', 'feature.purchasing', true, null), ('wahaj', 'feature.inventory_finance_link', false, null), ('wahaj', 'feature.inventory_reports_advanced', false, null),
  -- مقترح — غير معتمد
  ('fareed', 'limit.stock_locations', true, null), ('fareed', 'feature.inventory_transfers', true, null), ('fareed', 'feature.inventory_counts', true, null),
  ('fareed', 'feature.purchasing', true, null), ('fareed', 'feature.inventory_finance_link', true, null), ('fareed', 'feature.inventory_reports_advanced', true, null)
)
insert into plan_features (plan_id, feature_key, enabled, limit_value)
select p.id, m.feature_key, m.enabled, m.limit_value from matrix m join plans p on p.code = m.code
on conflict (plan_id, feature_key) do nothing;
