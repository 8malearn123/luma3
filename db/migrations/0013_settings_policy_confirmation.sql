-- 0013 Owner confirmation that booking/payment/cancellation terms were reviewed
-- (a pre-publication readiness item).
alter table tenant_settings add column booking_policy_confirmed_at timestamptz;
alter table tenant_settings add column booking_policy_text_ar text;
alter table tenant_settings add column booking_policy_text_en text;
