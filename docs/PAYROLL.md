# Payroll

Source: `src/server/domains/payroll/service.ts`, `documents.ts`, migration `db/migrations/0600_payroll.sql`, UI in `src/ui/payroll/*`.

## Formula

```
net pay = base salary + service commission + tips + bonuses − deductions − advances
```

| Part | Where it comes from |
|---|---|
| Base salary | `staff_pay_profiles.base_salary_minor`, monthly; 0 = commission and tips only. Only active, non-archived staff get it. |
| Service commission | `commission_entries` (earned minus reversals) from completed bookings. **Services only; products never earn commission.** |
| Tips | `payroll_entries` of kind `tip`, recorded from a booking (staff who served it) or from the entries tab. 100% to the staff member. |
| Bonuses / deductions | `payroll_entries` of kind `bonus` / `deduction`. |
| Advances | `payroll_entries` of kind `advance`: paid out when recorded and recovered in full from the payroll of the month they are dated in. |

## Service commission is the business's decision

- **Business switch** `tenant_settings.service_commission_enabled`: when off, no booking earns commission.
- **Default rate**: a business-wide percentage rule (`commission_rules` with no staff and no service).
- **Per service**: a switch (`service_commission_settings.commission_enabled`) and a percentage (a service-level `commission_rules` row). A service switched off earns no commission for anybody, whatever other rules say.
- Staff-specific exceptions remain available in Finance → Commissions (precedence staff+service > staff > service > default).
- Changing a rate deactivates the old rule and creates a new one, so each commission entry keeps the rule it was earned under.
- **Tips switch** `tenant_settings.tips_enabled`.

## Month close

- A month is a live draft until closed. Closing (`POST /payroll/close`) needs `payroll.manage`, happens once per month, and months close in order (the first close can be any month that has started).
- Closing freezes one `payroll_slips` row per staff member (`PAY-000001`…), records every settled commission entry and payroll entry in `payroll_settled_items` (primary key = can never be paid twice), and posts the journal.
- Anything recorded after the close (late completion, a reversal, a tip on the last day) is unsettled and carries into the next month automatically.
- Entries cannot be dated before the start of the latest closed month, and an entry settled in a closed month cannot be voided (application check plus a database trigger). Payslips, runs, payments and settled items are append-only.
- A payslip is paid once (`POST /payroll/slips/{id}/pay`).

## Journal

| Event | Entry |
|---|---|
| Tip recorded | Dr cash_on_hand (cash) or provider_clearing (POS) · Cr tips_payable |
| Advance paid | Dr staff_advances · Cr cash_on_hand |
| Month closed | Dr salaries_expense (base + bonus − deduction) · Dr commissions_payable · Dr tips_payable · Cr staff_advances · Cr payroll_payable (net) |
| Payslip paid | Dr payroll_payable · Cr cash_on_hand |

The finance report shows **salaries** (from closed months) and subtracts them from profit. Do not also record salaries as an expense of category "salaries" for months closed in payroll.

## Permissions

`payroll.view` and `payroll.manage`: owner and finance by default, delegable to managers. `payroll.view_own` (self-scoped): every role; staff see only their own draft and payslips (`GET /me/earnings`, `GET /payroll/slips/{id}`). Recording a tip needs `payments.collect` or `payroll.manage`. LUMA support grants do not include payroll.

## Not covered yet

No pro-rating for partial months, no advance instalments, no tiered commission, payouts from cash only.
