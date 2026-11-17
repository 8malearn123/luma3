-- LUMA-AUDIT-010: the finance report (hosting revenue/expense lines included) can be
-- exported as a CSV of report lines with their accounting basis.
alter table finance_exports drop constraint if exists finance_exports_kind_check;
alter table finance_exports add constraint finance_exports_kind_check check (kind in ('bookings', 'payments', 'journal', 'expenses', 'summary'));
