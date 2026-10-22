-- 0012 Reference data: LUMA plans Sanaa / Wahaj / Fareed.
-- Prices are intentionally NULL ("pricing not configured"): no final pricing has
-- been approved. Limits below are TEST VALUES, editable by the LUMA owner in
-- /platform/plans. Inserted only if absent; never overwrites edits.
insert into plans (code, name_ar, name_en, description_ar, description_en, price_monthly_minor, price_is_test, trial_days, grace_days, sort)
values
  ('sanaa', 'سناء', 'Sanaa', 'للخبيرات والصالونات الصغيرة في بدايتها', 'For independent experts and small salons getting started', null, true, 14, 7, 1),
  ('wahaj', 'وهج', 'Wahaj', 'للصالونات النامية مع فريق ومتجر', 'For growing salons with a team and a shop', null, true, 14, 7, 2),
  ('fareed', 'فريد', 'Fareed', 'للمراكز متعددة الفروع وكامل الأدوات', 'For multi-branch centers with every tool', null, true, 14, 7, 3)
on conflict (code) do nothing;

with matrix(code, feature_key, enabled, limit_value) as (values
  ('sanaa', 'limit.branches', true, 1), ('sanaa', 'limit.staff', true, 3), ('sanaa', 'limit.services', true, 30),
  ('sanaa', 'limit.products', true, 30), ('sanaa', 'limit.custom_pages', true, 3), ('sanaa', 'limit.ai_runs_monthly', true, 4),
  ('sanaa', 'feature.products', true, null), ('sanaa', 'feature.inventory', false, null), ('sanaa', 'feature.marketing_ai', true, null),
  ('sanaa', 'feature.customization_ai', true, null), ('sanaa', 'feature.campaigns', false, null), ('sanaa', 'feature.loyalty', false, null),
  ('sanaa', 'feature.gift_cards', false, null), ('sanaa', 'feature.memberships', false, null), ('sanaa', 'feature.waitlist', true, null),
  ('sanaa', 'feature.group_sessions', false, null), ('sanaa', 'feature.resources', false, null), ('sanaa', 'feature.finance_reports', true, null),
  ('sanaa', 'feature.remove_powered_by', false, null),

  ('wahaj', 'limit.branches', true, 2), ('wahaj', 'limit.staff', true, 12), ('wahaj', 'limit.services', true, 120),
  ('wahaj', 'limit.products', true, 300), ('wahaj', 'limit.custom_pages', true, 10), ('wahaj', 'limit.ai_runs_monthly', true, 20),
  ('wahaj', 'feature.products', true, null), ('wahaj', 'feature.inventory', true, null), ('wahaj', 'feature.marketing_ai', true, null),
  ('wahaj', 'feature.customization_ai', true, null), ('wahaj', 'feature.campaigns', true, null), ('wahaj', 'feature.loyalty', true, null),
  ('wahaj', 'feature.gift_cards', true, null), ('wahaj', 'feature.memberships', true, null), ('wahaj', 'feature.waitlist', true, null),
  ('wahaj', 'feature.group_sessions', true, null), ('wahaj', 'feature.resources', true, null), ('wahaj', 'feature.finance_reports', true, null),
  ('wahaj', 'feature.remove_powered_by', false, null),

  ('fareed', 'limit.branches', true, null), ('fareed', 'limit.staff', true, null), ('fareed', 'limit.services', true, null),
  ('fareed', 'limit.products', true, null), ('fareed', 'limit.custom_pages', true, null), ('fareed', 'limit.ai_runs_monthly', true, 100),
  ('fareed', 'feature.products', true, null), ('fareed', 'feature.inventory', true, null), ('fareed', 'feature.marketing_ai', true, null),
  ('fareed', 'feature.customization_ai', true, null), ('fareed', 'feature.campaigns', true, null), ('fareed', 'feature.loyalty', true, null),
  ('fareed', 'feature.gift_cards', true, null), ('fareed', 'feature.memberships', true, null), ('fareed', 'feature.waitlist', true, null),
  ('fareed', 'feature.group_sessions', true, null), ('fareed', 'feature.resources', true, null), ('fareed', 'feature.finance_reports', true, null),
  ('fareed', 'feature.remove_powered_by', true, null)
)
insert into plan_features (plan_id, feature_key, enabled, limit_value)
select p.id, m.feature_key, m.enabled, m.limit_value from matrix m join plans p on p.code = m.code
on conflict (plan_id, feature_key) do nothing;
