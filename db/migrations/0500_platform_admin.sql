-- ════════════════════════════════════════════════════════════════════════════
-- 0500 LUMA administration: admin MFA, plan/branch/template versioning,
-- subscription lifecycle bookkeeping, test-only platform invoices, support
-- grant revocation details.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Admin MFA (TOTP) ─────────────────────────────────────────────────────────
-- users.mfa_totp_secret_enc (0002) holds the ACTIVE secret, encrypted with
-- AES-256-GCM (key derived from AUTH_SECRET via HKDF). A pending secret is kept
-- separately until the user proves possession with a valid code.
alter table users add column mfa_enabled_at timestamptz;
alter table users add column mfa_pending_secret_enc text;
-- Last accepted TOTP time-step: a code can be used once (replay protection).
alter table users add column mfa_last_step bigint;
alter table users add constraint users_mfa_enabled_has_secret check (mfa_enabled_at is null or mfa_totp_secret_enc is not null);

-- Per-session second-factor verification for LUMA administration.
alter table sessions add column mfa_verified_at timestamptz;

-- ── Plans: optimistic concurrency for owner edits ────────────────────────────
alter table plans add column version int not null default 1;
-- No FK to users: plans are reference data that must survive account clean-up.
alter table plans add column updated_by uuid;

-- ── Subscriptions ────────────────────────────────────────────────────────────
alter table subscriptions add column paused_at timestamptz;
alter table subscriptions add column version int not null default 1;
create index subscriptions_status_idx on subscriptions (status, trial_ends_at);

-- ── Platform invoices (LUMA subscription revenue; never salon sales) ─────────
-- No real charging exists in this delivery: every invoice is a labelled TEST
-- invoice that the platform owner marks paid manually. The check below makes
-- that a database invariant; drop it only when a real billing provider exists.
alter table platform_invoices add constraint platform_invoices_test_only check (is_test);
alter table platform_invoices add column plan_id uuid references plans(id);
alter table platform_invoices add column marked_paid_by uuid references users(id);
alter table platform_invoices add column note text check (note is null or length(note) <= 500);
create index platform_invoices_status_idx on platform_invoices (status, issued_at desc);
create sequence platform_invoice_number_seq;

-- ── Support grants: who revoked and why ──────────────────────────────────────
alter table support_access_grants add column revoked_by uuid references users(id);
alter table support_access_grants add column revoke_reason text check (revoke_reason is null or length(revoke_reason) <= 300);
create index support_grants_active_idx on support_access_grants (platform_user_id, expires_at) where revoked_at is null;

-- ── Branches: optimistic concurrency ─────────────────────────────────────────
alter table branches add column version int not null default 1;

-- ── Templates: review trail + optimistic concurrency ─────────────────────────
alter table templates add column version int not null default 1;
alter table templates add column updated_by uuid references users(id);
alter table templates add column approved_by uuid references users(id);
alter table templates add column approved_at timestamptz;

-- ── Audit search ─────────────────────────────────────────────────────────────
create index audit_logs_actor_idx on audit_logs (actor_user_id, created_at desc);
create index audit_logs_created_idx on audit_logs (created_at desc, id desc);

grant usage, select on sequence platform_invoice_number_seq to {{APP_ROLE}};

select app.apply_conventions('{{APP_ROLE}}');
