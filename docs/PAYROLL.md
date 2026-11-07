# Payroll

Source: `src/server/domains/payroll/service.ts`, `documents.ts`, migration `db/migrations/0600_payroll.sql`, UI in `src/ui/payroll/*` (plus the seller field in `src/ui/commerce/OrderDrawer.tsx` and the tip button in `src/ui/bookings/BookingDrawer.tsx`).

## Formula

```
net pay = base salary (pro-rated) + service commission + product commission
        + tips + bonuses − deductions − advance instalments
```

| Part | Rule |
|---|---|
| Base salary | `staff_pay_profiles.base_salary_minor` × days employed in the month ÷ days in the month. Days employed come from `employment_start` / `employment_end` (both optional, inclusive). |
| Service commission | Monthly service sales of the staff member × the services rate (see tiers). Sales = each completed booking item's share of the booking's total minus tax, after refunds. A booking counts in the month it was completed. |
| Product commission | Monthly product sales × the products rate. Sales are lines of paid orders whose **seller** (`orders.sold_by_staff_id`) is the staff member; an order counts in the month it was paid. Orders without a seller earn nobody commission. |
| Tips | `payroll_entries` of kind `tip`, from a booking (only staff who served it) or the entries tab; 100% to the staff member. |
| Bonuses / deductions | `payroll_entries` of kind `bonus` / `deduction`. |
| Advances | `payroll_entries` of kind `advance` with `installments` (1–36). Paid out when recorded (cash or bank), then recovered one instalment per month starting in the month of the advance's date. Instalments are `floor(amount / n)`; the last takes the remainder. |

## Commission is decided by the business, per category

`commission_policies` has one row per category, `services` and `products`, each with:

- `enabled` — both start **off**; product sales earn nothing until the business switches product commission on;
- `rate_bp` — the base rate;
- `tiers` — optional, up to 10, thresholds strictly increasing: `[{threshold_minor, rate_bp}]`. The highest tier whose threshold the staff member's **monthly** sales in that category reached sets the rate for **all** her sales of that category that month.

There are no per-service rates. **Per-staff overrides** (`staff_commission_overrides`, migration 0610) replace the business policy of a category for one staff member (`enabled`, `rate_bp`, optional tiers — same rules); `PUT /payroll/commission-overrides/{staffId}` with `null` removes one. The rate used is frozen on the payslip as before (`service_rate_bp`, `product_rate_bp`), and the draft sheet shows `commission_override` per category. The earlier per-booking rule engine (`commission_rules`, `commission_entries`) is retired; its rows stay as history and earlier postings remain in the journal.

Tips can be switched off with `tenant_settings.tips_enabled`.

## Month close

- A month is a live draft until closed. `POST /payroll/close` (needs `payroll.manage`) closes it once; months close in order; a month that has not started cannot be closed.
- Closing freezes one `payroll_slips` row per staff member (`PAY-000001`…) with the amounts **and** the rates and day counts used, records every settled booking item, order item, entry and advance instalment in `payroll_settled_items` (primary key = nothing is paid twice), and posts the journal.
- Anything recorded after a close carries into the next month automatically. Entries cannot be dated before the start of the latest closed month. A settled entry (even one instalment of an advance) cannot be voided, and the seller of an order already settled cannot change. Runs, payslips, payments and settled items are append-only.
- A payslip is paid once, from cash or by bank transfer.
- A month cannot close while **deduction suggestions** dated up to its end are pending (`payroll_suggestions_pending`). Lateness, absence and unpaid-leave suggestions are produced by HR ([HR.md](HR.md)); an approved one becomes a `deduction` entry, a rejected one is kept for the record.
- An approved **advance request** (HR approval chain) records a normal `advance` entry with the instalments the approver set.

## Journal

| Event | Entry |
|---|---|
| Tip recorded | Dr `cash_on_hand` (cash) or `provider_clearing` (card terminal) · Cr `tips_payable` |
| Advance paid out | Dr `staff_advances` · Cr `cash_on_hand` or `bank` |
| Month closed | Dr `salaries_expense` (base + bonus − deduction) · Dr `commissions_expense` · Dr `tips_payable` · Cr `staff_advances` (instalments) · Cr `payroll_payable` (net) |
| Payslip paid | Dr `payroll_payable` · Cr `cash_on_hand` or `bank` |

The finance report takes **commissions** and **salaries** from the journal and subtracts both from profit. Do not also record salaries as an expense of category "salaries" for months closed in payroll.

## Permissions

`payroll.view` and `payroll.manage`: owner and finance by default, delegable to managers. `payroll.view_own` (self-scoped): every role; staff see only their own draft and payslips (`GET /me/earnings`, `GET /payroll/slips/{id}`). Recording a tip needs `payments.collect` or `payroll.manage`; setting an order's seller needs `orders.manage` or `payroll.manage`. LUMA support grants do not include payroll.

## Not covered

A refund made after a month is closed does not reduce commission already paid (record a deduction).
