-- 0022 Pseudonymous storefront analytics session that started a booking/order,
-- so the server-side conversion (confirmed / paid, often via webhook later) can
-- be linked to the session for the conversion rate. Not a person identifier.
alter table bookings add column analytics_session_id text check (analytics_session_id ~ '^[A-Za-z0-9_-]{8,64}$');
alter table orders add column analytics_session_id text check (analytics_session_id ~ '^[A-Za-z0-9_-]{8,64}$');
