# Permissions

Source of truth: `src/server/auth/capabilities.ts` (roles, capabilities, delegation), `src/server/tenancy/access.ts` (access resolution, plan gates), `src/server/http/route.ts` (enforcement order), `src/server/domains/platform/guard.ts` (platform MFA and step-up) and `src/shared/plans.ts` with migration `0012_reference_plans.sql` (plan features).

Capabilities are defined **in code**, not in `roles` / `permissions` tables. A membership stores its `role` plus `granted_capabilities[]` and `revoked_capabilities[]`. The UI hides what a user cannot do, and the server enforces it regardless.

## Tenant roles

`owner`, `manager`, `receptionist`, `specialist`, `finance` (`TENANT_ROLES`). There is exactly one active owner per business (partial unique index `memberships_one_owner`). Invitations cannot carry the `owner` role (CHECK constraint).

Effective capabilities are computed by `effectiveCapabilities(role, granted, revoked)`:

```
effective = role defaults
          + granted ∩ delegable(role)   (owner-only capabilities are always dropped)
          − revoked                     (ignored for the owner)
```

Unknown or non-delegable grants are **ignored**, not trusted. When a grant is written, `invalidGrants()` rejects them. A member of a **suspended** tenant gets an empty capability set.

### Capability matrix

Legend: ✓ = role default, D = delegable to that role (the "if delegated" column of the spec), blank = never available to that role. The support columns are what a LUMA support user gets through a time-limited grant (see below).

| Capability | owner | manager | receptionist | specialist | finance | support (read) | support (write) |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `business.manage` (owner-only) | ✓ |  |  |  |  |  |  |
| `subscription.manage` (owner-only) | ✓ |  |  |  |  |  |  |
| `subscription.view` | ✓ | D |  |  | D | ✓ | ✓ |
| `team.manage` | ✓ | D |  |  |  |  |  |
| `staff.edit` | ✓ | D |  |  |  |  | ✓ |
| `staff.edit_own_profile` | ✓ |  |  | ✓ |  |  |  |
| `catalog.edit` | ✓ | D |  |  |  |  | ✓ |
| `costs.view` | ✓ | D |  |  | ✓ |  |  |
| `builder.edit` | ✓ | D | D |  |  |  | ✓ |
| `builder.publish` | ✓ | D |  |  |  |  | ✓ |
| `bookings.view_all` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |
| `bookings.manage` | ✓ | ✓ | ✓ |  |  |  | ✓ |
| `bookings.view_assigned` | ✓ |  |  | ✓ |  |  |  |
| `bookings.manage_assigned` | ✓ |  |  | ✓ |  |  |  |
| `bookings.view_financial` | ✓ | ✓ |  |  | ✓ | ✓ | ✓ |
| `customers.view` | ✓ | ✓ | ✓ | D |  | ✓ | ✓ |
| `customers.manage` | ✓ | ✓ | ✓ |  |  |  |  |
| `customers.view_notes` | ✓ | ✓ | ✓ |  |  |  |  |
| `orders.view` | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `orders.manage` | ✓ | ✓ | ✓ |  |  |  |  |
| `inventory.view` | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |
| `inventory.manage` | ✓ | ✓ |  |  |  |  |  |
| `payments.collect` | ✓ | ✓ | ✓ |  |  |  |  |
| `payments.configure` | ✓ | D |  |  |  |  |  |
| `refunds.request` | ✓ | ✓ | D |  | ✓ |  |  |
| `refunds.approve` | ✓ | D |  |  | ✓ |  |  |
| `finance.view` | ✓ | D |  |  | ✓ | ✓ | ✓ |
| `finance.manage` | ✓ |  |  |  | ✓ |  |  |
| `finance.export` | ✓ | D |  |  | ✓ |  |  |
| `schedule.manage` | ✓ | ✓ |  |  |  |  | ✓ |
| `schedule.view_own` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `leave.request` | ✓ |  |  | ✓ |  |  |  |
| `leave.approve` | ✓ | ✓ |  |  |  |  |  |
| `attendance.own` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `attendance.manage` | ✓ | ✓ |  |  |  |  |  |
| `incidents.submit` | ✓ | D | D | D | D |  |  |
| `incidents.review` | ✓ | D |  |  |  |  |  |
| `marketing.view` | ✓ | ✓ |  |  |  | ✓ | ✓ |
| `marketing.manage` | ✓ | D |  |  |  |  |  |
| `campaigns.approve` | ✓ | D |  |  |  |  |  |
| `analytics.view` | ✓ | ✓ | D |  | D | ✓ | ✓ |
| `loyalty.manage` | ✓ | ✓ | D |  |  |  |  |
| `giftcards.manage` | ✓ | ✓ | ✓ |  |  |  |  |
| `memberships.manage` | ✓ | ✓ |  |  |  |  |  |
| `waitlist.manage` | ✓ | ✓ | ✓ |  |  |  |  |
| `audit.view` | ✓ | D |  |  |  | ✓ | ✓ |

Delegable allowlists, verbatim from `ROLE_DELEGABLE`:

| Role | Delegable capabilities |
|---|---|
| owner | none (already has everything) |
| manager | `subscription.view`, `team.manage`, `staff.edit`, `catalog.edit`, `costs.view`, `builder.edit`, `builder.publish`, `finance.view`, `finance.export`, `refunds.approve`, `payments.configure`, `incidents.submit`, `incidents.review`, `marketing.manage`, `campaigns.approve`, `audit.view` |
| receptionist | `incidents.submit`, `builder.edit`, `refunds.request`, `analytics.view`, `loyalty.manage` |
| specialist | `incidents.submit`, `customers.view` |
| finance | `subscription.view`, `analytics.view`, `incidents.submit` |

### Owner-only capabilities

`business.manage` and `subscription.manage` (`OWNER_ONLY`). They are never added by delegation, even if a grant array contains them, and `invalidGrants()` rejects them.

### Role assignment

`canAssignRole(actorRole, actorCaps, target)`:

- Nobody can assign `owner` through this path. Ownership transfer is a separate flow; it is not implemented as an endpoint in this delivery.
- The owner can assign any other role.
- A member with `team.manage` (a delegated manager) can assign non-manager roles only, never peers or owners.

Changing a member (`PATCH /api/v1/t/{slug}/members/{id}`) requires `team.manage` **and step-up**.

### Assigned-only access (specialists)

`bookings.view_assigned` and `bookings.manage_assigned` limit a specialist to bookings with a current (non-superseded) item assigned to her `staff_profile_id`. Lists filter on it. Detail reads and transitions return 404 for bookings she cannot see, and 403 for bookings she can see but not act on. Private customer notes need `customers.view_notes`, which specialists cannot get even with `customers.view` delegated.

## Platform roles

`platform_owner`, `support_admin`, `policy_reviewer`, `technical_admin` (`PLATFORM_ROLES`). They are stored in `platform_roles`, are never granted by registration, and are created only by `scripts/grant-platform-role.ts` (the first owner) or by a platform owner with step-up (`POST /api/v1/platform/users/{id}/roles`). The last active `platform_owner` cannot be revoked or suspended.

| Platform capability | platform_owner | support_admin | policy_reviewer | technical_admin |
|---|:-:|:-:|:-:|:-:|
| `platform.tenants.view` | ✓ | ✓ | ✓ | ✓ |
| `platform.tenants.manage` | ✓ |  |  |  |
| `platform.plans.manage` | ✓ |  |  |  |
| `platform.subscriptions.manage` | ✓ |  |  |  |
| `platform.users.manage` | ✓ |  |  |  |
| `platform.roles.manage` | ✓ |  |  |  |
| `platform.templates.manage` | ✓ |  |  |  |
| `platform.policy.review` | ✓ |  | ✓ |  |
| `platform.audit.view` | ✓ | ✓ |  | ✓ |
| `platform.integrations.view` | ✓ | ✓ |  | ✓ |
| `platform.ai_usage.view` | ✓ |  |  | ✓ |
| `platform.revenue.view` | ✓ |  |  |  |
| `platform.support.access` | ✓ | ✓ |  |  |

Every `/api/v1/platform/**` handler is built with `platformRoute()`. A caller with **no** platform role gets **404**, not 403, so the platform API does not reveal that it exists. A missing specific capability also returns 404. `GET /api/v1/platform/overview` and the MFA/me endpoints need only some platform role. Platform roles grant no tenant capabilities.

## Request enforcement order

`route()` in `src/server/http/route.ts` runs these checks in order:

1. CSRF: mutating methods need the header `x-luma-csrf: 1`, and any `Origin` header must match `APP_URL` or the request origin.
2. Session: auth modes `public`, `optional`, `user`, `tenant`, `platform`.
3. `requireVerified`: a verified email or phone (bookings, checkout, business creation).
4. `stepUp` (password re-auth within 10 minutes).
5. Rate limit.
6. Tenant routes (`/api/v1/t/{tenantSlug}/…`): `resolveTenantAccess()` uses only the caller's **own** membership or an active support grant. Unknown slugs and slugs the caller is not a member of both return the same 404. Then the `capability` check (any-of), the plan `feature` check, and the read-only workspace check for mutations (unless `allowReadOnly`).
7. Platform routes: platform capability, then MFA (`requirePlatformMfa`), then step-up.
8. `Idempotency-Key` presence where `idempotency: 'required'`.
9. Zod input validation.

Some checks run inside domain services instead, for example the upload purpose → capability map in `assets/route.ts`, `reorder` choosing `staff.edit` or `catalog.edit`, and plan features re-checked in services such as gift cards, memberships and inventory movements.

## Support access grants

Implementation: `src/server/domains/platform/support.ts`, `resolveTenantAccess()` and `supportCapabilities()`.

| Property | Rule |
|---|---|
| Who | A user with `platform.support.access` (platform_owner, support_admin). Creating a grant needs **step-up**. |
| Reason | Required, at least 10 characters (DB CHECK and zod). |
| Level | `read` or `write`. A `read` grant marks the workspace **read-only**, so every tenant mutation returns 403 `read_only`. |
| Duration | 1–24 hours (zod). The DB CHECK enforces `expires_at <= starts_at + 24h`. Expiry is checked on every request, so no job is needed. |
| Capabilities | read: `bookings.view_all`, `bookings.view_financial`, `customers.view`, `orders.view`, `inventory.view`, `finance.view`, `analytics.view`, `marketing.view`, `subscription.view`, `audit.view`. write adds `builder.edit`, `builder.publish`, `catalog.edit`, `staff.edit`, `bookings.manage`, `schedule.manage`. |
| MFA | If the support user has enabled MFA, the grant is usable only from a session that passed TOTP verification within the last 12 hours (`mfaPending`). |
| No impersonation | The support user acts as themselves. The audit actor kind is `support`, and `support_grant_id` is recorded on every audited action. The business owner (members with `business.manage`) is notified when access starts and ends. |
| Revocation | `POST /api/v1/platform/support-grants/{id}/revoke`: the grant holder can end their own grant; a platform owner (`platform.roles.manage`) can revoke any grant. Suspending an account also revokes its active grants. |

## Step-up re-authentication

`POST /api/v1/auth/reauth` (password, rate-limited to 10 per 15 minutes) sets `sessions.reauthenticated_at`. `requireStepUp()` accepts it for **10 minutes** (`STEP_UP_WINDOW_MIN`). Otherwise it returns 401 `reauthentication_required`.

Endpoints declared with `stepUp: true`:

| Scope | Endpoints |
|---|---|
| Tenant | `POST finance/exports`; `POST gift-cards/{id}/void`; `PATCH members/{id}`; `POST payment-accounts`, `DELETE payment-accounts/{id}`; `POST policies/decisions`, `POST policies/decisions/{id}/end`; `POST policies/appeals/{id}/resolve`; `POST policies/incidents/{id}/escalate` |
| Platform | `POST mfa/enroll`, `POST mfa/disable`; `PUT plans/{id}`; `POST invoices/{id}`; `POST subscriptions/{id}/actions`, `POST subscriptions/{id}/invoices`; `POST support-grants`; `POST tenants/{id}/status`; `POST users/{id}/status`, `POST users/{id}/roles`, `POST users/{id}/mfa-reset`; `POST policies/decisions`, `POST policies/decisions/{id}/end`, `POST policies/appeals/{id}/resolve`, `POST policies/escalations/{id}/dismiss`, `POST policies/rules`, `PATCH policies/rules/{id}` |

## Admin MFA (TOTP)

Implementation: `src/server/domains/platform/mfa.ts`, `totp.ts`, `mfa-state.ts` and `guard.ts`.

- Enrolment (`POST /api/v1/platform/mfa/enroll`, step-up) stores a pending secret encrypted with AES-256-GCM, using a key derived from `AUTH_SECRET` via HKDF. Activation needs a valid code. 6 digits, 30-second period, SHA1.
- Each accepted code advances `users.mfa_last_step`, so a code cannot be replayed. Code checks are rate-limited to 10 per 15 minutes per user.
- Once MFA is enabled, every platform endpoint and page (except the MFA and `me` endpoints) requires the **current session** to have passed TOTP within **12 hours** (`MFA_SESSION_HOURS`). The API returns 403 `mfa_required`; pages redirect to `/platform/mfa`.
- A platform owner can reset another admin's MFA (`users/{id}/mfa-reset`, step-up, audited).
- **Gap:** enabling MFA is not mandatory for platform users. A platform user who never enrols is not asked for a second factor.

## Plan feature and limit gating

Plan data lives in `plans` and `plan_features` (seeded by `0012`, editable by the platform owner in `/platform/plans`). The keys the server enforces are in `src/shared/plans.ts`. **Prices are `NULL` ("pricing not configured") and every plan has `price_is_test = true`. The limits below are test values, not approved final values.**

Entitlements come from the tenant's current subscription (`loadEntitlements`). A workspace is **read-only** when there is no subscription, or when it is `expired`, `cancelled` or `paused`, or `past_due` past `grace_until`, or when the tenant is suspended. Data stays readable; mutations return 403 `read_only`. Subscription endpoints use `allowReadOnly` so the owner can still change plan.

| Key | Sanaa | Wahaj | Fareed |
|---|:-:|:-:|:-:|
| `limit.branches` | 1 | 2 | unlimited |
| `limit.staff` | 3 | 12 | unlimited |
| `limit.services` | 30 | 120 | unlimited |
| `limit.products` | 30 | 300 | unlimited |
| `limit.custom_pages` | 3 | 10 | unlimited |
| `limit.ai_runs_monthly` | 4 | 20 | 100 |
| `feature.products` | on | on | on |
| `feature.inventory` | off | on | on |
| `feature.marketing_ai` | on | on | on |
| `feature.customization_ai` | on | on | on |
| `feature.campaigns` | off | on | on |
| `feature.loyalty` | off | on | on |
| `feature.gift_cards` | off | on | on |
| `feature.memberships` | off | on | on |
| `feature.waitlist` | on | on | on |
| `feature.group_sessions` | off | on | on |
| `feature.resources` | off | on | on |
| `feature.finance_reports` | on | on | on |
| `feature.remove_powered_by` | off | off | on |

Trial: 14 days, grace: 7 days, for all three plans.

Enforcement:

- **Features**: `requireFeature()` from the `feature` option on routes (for example `feature.marketing_ai` on `/marketing/**`, `feature.campaigns` on campaigns and segments, `feature.products` on orders and products, `feature.inventory` on inventory). Some services check again internally. The storefront hides `product_grid` / `product_feature` blocks and forces "Powered by LUMA" without `feature.remove_powered_by`.
- **Limits**: `requireWithinLimit()` inside the creating transaction: `limit.services` (catalog), `limit.staff` (team), `limit.branches` (settings), `limit.products` (products, including un-archiving), `limit.custom_pages` (builder). `limit.ai_runs_monthly` is consumed atomically per Loom AI job in `usage_counters` (metric `ai_runs`); when it is exhausted, Loom falls back to rules.
- **Downgrades** never delete data. Exceeded limits are recorded in `subscriptions.overage_state`, and new creation of those resources stays blocked until the business is back within limits.

Known inconsistencies:

- The storefront customization assistant (`feature.customization_ai`) does **not** consume `limit.ai_runs_monthly`.
- The usage report in `subscriptions/service.ts` counts `ai_runs` rows with status `succeeded` this month. That is a different measure from the `usage_counters` budget that Loom enforces.
- A few routes declare a weaker capability than the action suggests: `POST finance/invoices` (issue an invoice) and `POST payments/reconcile` require only `finance.view`.
