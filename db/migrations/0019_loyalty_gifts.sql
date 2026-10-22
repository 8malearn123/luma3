-- 0019 Loyalty activity tracking (inactivity-based expiry rule) and gift card
-- presentation templates.
alter table loyalty_accounts add column last_activity_at timestamptz not null default now();
alter table gift_cards add column delivery_note text;
create unique index customer_memberships_paid_once on payments (customer_membership_id) where customer_membership_id is not null and status = 'captured';
