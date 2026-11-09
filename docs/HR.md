# HR

Source: `src/server/domains/hr/*` (`rules.ts` pure rules, `balance.ts`, `requests.ts`, `deductions.ts`, `reroute.ts`, `files.ts`, `settings.ts`, `jobs.ts`), per-staff commission in `src/server/domains/payroll/service.ts`, migration `db/migrations/0610_hr.sql`, routes under `/api/v1/t/{slug}/hr/*`, `/payroll/suggestions`, `/payroll/commission-overrides`, `/me/hr`, UI in `src/ui/hr/*` (Team → Requests / Staff files / Leave balances and reroutes, Attendance flags, Payroll → Deduction suggestions and staff-specific commission, staff portal cards). Product decisions: [DECISIONS_2026-11.md](DECISIONS_2026-11.md). Permissions: [PERMISSIONS.md](PERMISSIONS.md#hr-see-hrmd).

## 1. Annual leave balance

| Rule | Decision |
|---|---|
| Entitlement | 21 days a year; 30 days a year once five full years of service are completed. |
| Accrual | Monthly: 1.75 days for each **completed** month of service (months 1–60), 2.5 days for each month after the 60th. A month completes on the hire date's day-of-month (clamped to short months: hired on the 31st → completes on 28/29 Feb). Accrual is computed, never stored. |
| Hire date | `staff_pay_profiles.employment_start` (editable in Payroll → Salaries or the staff file). Without a hire date there is **no balance**: it is shown as "set the hire date" and nothing is enforced. |
| Carry-over | Unused days carry over without limit or expiry: balance = accrued + adjustments − taken. |
| Days counted | **Working days per the staff schedule**: a date counts when the staff member has scheduled working windows that day (weekly hours ± date overrides; a day-off override does not count). A staff member with no weekly schedule at all counts calendar days. The count is taken at submission and stored on the request (`leave_days`), so later schedule changes do not alter an approved leave. |
| Consumption | Only **approved annual** leave consumes the balance (ledger row `taken`, bucket `annual`). Sick leave is recorded in its own bucket (`sick`) and shown as "sick days this year"; emergency and unpaid leave consume nothing. |
| Insufficient balance | Checked against the balance projected at the leave's start date minus other pending annual requests. `hr_settings.leave_balance_policy`: `block` (default) → 422 `leave_balance_insufficient` with `available`/`requested`; `warn` → accepted, flagged `balance_warning` for approvers. Re-checked at final approval. |
| Adjustments | The owner (`hr.configure`) adds or removes days with a mandatory note (`POST /hr/balances/{staffId}`); append-only ledger + audit + notification to the staff member. |

Shown in Team → Leave (team balances table, owner adjust), in the leave/request forms (own balance line), and in the staff portal ("My balance and file").

## 2. Approval chains and request types

- Seeded per business on first use: annual, sick, emergency and unpaid leave (chain manager → owner); advance request, salary-certificate letter (field "addressed to"), experience letter (chain owner).
- The owner (`hr.configure`) edits each type's name, ordered chain (1–5 roles among manager, owner, finance, receptionist), custom fields (text / number / date / select, required flag) and active flag, and creates custom types (`other`, `letter`, or `leave` with a balance kind).
- A request snapshots the chain. At each step a member with that role approves (moving it on) or rejects, with an optional note; she cannot decide her own request. **The owner can act at any step and her approval is final** (history records `by_owner`). Every action is in `hr_request_actions` (append-only). The staff member can cancel while pending (the linked leave row is cancelled too).
- **Leave requests** also create a `leave_requests` row (`requested`), so the existing leave list and availability engine keep working. The original endpoints are kept: `POST /leave` for annual/sick/emergency/unpaid joins the matching chain (personal/other keep the original one-step approval), and `POST /leave/{id}` decides the current step of the linked request.
- **Advance request**: staff chooses amount and instalments; the approver may change instalments (and amount) and the payout method; the final approval records a payroll `advance` entry (journal as in PAYROLL.md).
- Letters and custom requests end at approval (no document is generated).

## 3. Unpaid leave

On final approval, one deduction **suggestion** per calendar month the leave touches: working days in that month × (monthly base ÷ days in that month). It waits for the owner in Payroll like lateness and absence (§4). No suggestion without a base salary.

## 4. Lateness and absence

| Rule | Decision |
|---|---|
| Scheduled shift | The day's working windows (weekly hours ± overrides − breaks, all branches); start = first window. |
| Late | First clock-in of the local day later than start + grace (`hr_settings.grace_minutes`, default 10). Once the grace is exceeded **the whole delay counts** (12 minutes late with 10 grace = 12). |
| Absent | A scheduled working day that is over (or whose shift ended) with no clock-in and no approved leave overlapping the shift. |
| Day's wage | Monthly base ÷ days in that month. |
| Lateness deduction | Day's wage ÷ scheduled minutes that day × minutes late, capped at one day's wage. |
| Absence deduction | One day's wage. |
| Who | Only staff who use the attendance clock (at least one clock event ever) and have a base salary; days before the hire date, after the end date, or inside a closed payroll month are skipped. `attendance_deductions = false` turns it off. |

Suggestions are created by the periodic job `hr.attendance-scan` (last three days, every 6 hours) and on demand from Payroll → Deduction suggestions ("compare attendance with schedule", whole month up to today); each staff/day/kind has one dedupe key, so nothing is suggested twice. The owner approves (→ `deduction` entry dated on the day, or today if that month is already closed) or rejects, singly or in bulk. **A month cannot be closed while suggestions dated up to its end are pending.** Late/absent flags ("تأخير n دقيقة", "غياب") appear on Team → Attendance and in the staff portal (`GET /hr/attendance`).

## 5. Rerouting bookings after leave approval

When a leave is approved, its overlapping bookings are recorded (`affected_booking_ids`) and booking managers are notified with a link to Team → Leave → "Reroute appointments" (`GET /hr/leave/{id}/reroutes`). For each booking still on the staff member the system lists colleagues who are qualified for all her items and free at the same times (resolved and validated by the booking engine exactly like a reschedule, with the booking's own allocations excluded), same price first. Actions (`POST`, `bookings.manage`):

- `reassign` — one click: atomic reschedule onto the colleague at the same time (a different price needs explicit acceptance: `price_changed` → `accept_total_minor`).
- `reschedule` — new start time (optionally another specialist), validated by the engine.
- `cancel` — cancellation with reason through the normal transition (refund policy, customer messages via the outbox) plus an in-app notice to the customer.

Every action is logged in `booking_reroutes` (append-only) and shown under the list.

## 6. Staff file (owner only)

Employee number (unique per business), nationality, residence, ID type (national ID / iqama / border number), ID number (returned masked `••••••6789`; `POST …/reveal` returns it and is audited; the number never enters the audit log), ID expiry, hire date (= `employment_start`), admin notes, and private documents (PDF kept as is after a signature check, images decoded and re-encoded to WebP; up to 10 MB; stored under `tenants/{id}/staff-documents/`, served only through the owner-only route with `no-store`; each view audited). Only `staff_file.manage` — an owner-only capability that cannot be delegated and is not in support grants — reaches these routes. The staff member sees, in the portal, her employee number, hire date, nationality, ID type and expiry, and document titles with expiry dates — never the ID number, residence, notes or files.

Expiry alerts: job `hr.expiry-alerts` (every 12 hours) notifies the owner(s) in-app when an ID/iqama or a document expires within 60, 30 or 7 days — once per threshold (notification dedupe key), so a missed run still alerts and nothing repeats. No external messaging provider is connected; alerts are in-app.

## 7. Staff-specific commission

See PAYROLL.md: `staff_commission_overrides` replaces the business category policy for one staff member; the rate used is frozen on the payslip.

## Not covered

- Partial-day leave is counted as whole working days of the dates it touches.
- Approved leave cannot be cancelled through the chain (reject or adjust the balance instead).
- No generated letter documents for letter requests.
- The ID number is protected by tenant RLS, masking and audited reveal, not by column encryption.
