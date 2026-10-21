/**
 * Capability model for business workspaces and LUMA administration.
 *
 * Roles grant a default capability set; owners/delegated managers may grant
 * additional capabilities from a per-role *delegable* allowlist, or revoke
 * defaults. Nothing outside the allowlist can be granted, so a membership can
 * never escalate itself to platform powers or ownership.
 *
 * See PERMISSIONS.md for the matrix and enforcement points.
 */

export const TENANT_ROLES = ['owner', 'manager', 'receptionist', 'specialist', 'finance'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const CAPABILITIES = [
  // Business & subscription
  'business.manage',
  'subscription.manage',
  'subscription.view',
  // Team
  'team.manage',
  'staff.edit',
  'staff.edit_own_profile',
  // Catalog
  'catalog.edit',
  'costs.view',
  // Storefront
  'builder.edit',
  'builder.publish',
  // Bookings
  'bookings.view_all',
  'bookings.manage',
  'bookings.view_assigned',
  'bookings.manage_assigned',
  'bookings.view_financial',
  // Customers
  'customers.view',
  'customers.manage',
  'customers.view_notes',
  // Commerce
  'orders.view',
  'orders.manage',
  'inventory.view',
  'inventory.manage',
  // Money
  'payments.collect',
  'payments.configure',
  'refunds.request',
  'refunds.approve',
  'finance.view',
  'finance.manage',
  'finance.export',
  // Schedules & HR
  'schedule.manage',
  'schedule.view_own',
  'leave.request',
  'leave.approve',
  'attendance.own',
  'attendance.manage',
  // Policy
  'incidents.submit',
  'incidents.review',
  // Marketing & analytics
  'marketing.view',
  'marketing.manage',
  'campaigns.approve',
  'analytics.view',
  // Engagement
  'loyalty.manage',
  'giftcards.manage',
  'memberships.manage',
  'waitlist.manage',
  // Governance
  'audit.view',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ALL = new Set<Capability>(CAPABILITIES);

const ROLE_DEFAULTS: Record<TenantRole, readonly Capability[]> = {
  owner: CAPABILITIES,
  manager: [
    'bookings.view_all', 'bookings.manage', 'bookings.view_financial',
    'customers.view', 'customers.manage', 'customers.view_notes',
    'orders.view', 'orders.manage', 'inventory.view', 'inventory.manage',
    'payments.collect', 'refunds.request',
    'schedule.manage', 'leave.approve', 'attendance.manage', 'attendance.own', 'schedule.view_own',
    'marketing.view', 'analytics.view', 'waitlist.manage', 'giftcards.manage', 'loyalty.manage', 'memberships.manage',
  ],
  receptionist: [
    'bookings.view_all', 'bookings.manage',
    'customers.view', 'customers.manage', 'customers.view_notes',
    'orders.view', 'orders.manage', 'inventory.view',
    'payments.collect', 'waitlist.manage', 'giftcards.manage',
    'attendance.own', 'schedule.view_own',
  ],
  specialist: [
    'bookings.view_assigned', 'bookings.manage_assigned',
    'schedule.view_own', 'leave.request', 'attendance.own', 'staff.edit_own_profile',
  ],
  finance: [
    'finance.view', 'finance.manage', 'finance.export', 'costs.view',
    'bookings.view_financial', 'orders.view', 'refunds.request', 'refunds.approve',
    'attendance.own', 'schedule.view_own',
  ],
};

/** What may be delegated on top of each role's defaults ("If delegated" in the matrix). */
const ROLE_DELEGABLE: Record<TenantRole, readonly Capability[]> = {
  owner: [],
  manager: [
    'subscription.view', 'team.manage', 'staff.edit', 'catalog.edit', 'costs.view', 'builder.edit', 'builder.publish',
    'finance.view', 'finance.export', 'refunds.approve', 'payments.configure',
    'incidents.submit', 'incidents.review', 'marketing.manage', 'campaigns.approve', 'audit.view',
  ],
  receptionist: ['incidents.submit', 'builder.edit', 'refunds.request', 'analytics.view', 'loyalty.manage'],
  specialist: ['incidents.submit', 'customers.view'],
  finance: ['subscription.view', 'analytics.view', 'incidents.submit'],
};

/** Capabilities that must never be granted to anyone but the owner, even by delegation. */
const OWNER_ONLY: readonly Capability[] = ['subscription.manage', 'business.manage'];

export function roleDefaults(role: TenantRole): ReadonlySet<Capability> {
  return new Set(ROLE_DEFAULTS[role]);
}

export function delegableFor(role: TenantRole): readonly Capability[] {
  return ROLE_DELEGABLE[role];
}

export function isCapability(v: string): v is Capability {
  return ALL.has(v as Capability);
}

/**
 * Effective capabilities = role defaults + delegated grants (allowlisted) − revocations.
 * Unknown or non-delegable grants are ignored rather than trusted.
 */
export function effectiveCapabilities(role: TenantRole, granted: readonly string[] = [], revoked: readonly string[] = []): Set<Capability> {
  const caps = new Set<Capability>(ROLE_DEFAULTS[role]);
  const delegable = new Set(ROLE_DELEGABLE[role]);
  for (const g of granted) {
    if (isCapability(g) && delegable.has(g) && !OWNER_ONLY.includes(g)) caps.add(g);
  }
  if (role !== 'owner') {
    for (const r of revoked) if (isCapability(r)) caps.delete(r);
  }
  return caps;
}

/** Validates a grant request; returns the list of rejected capabilities. */
export function invalidGrants(role: TenantRole, granted: readonly string[]): string[] {
  const delegable = new Set<string>(ROLE_DELEGABLE[role]);
  return granted.filter((g) => !isCapability(g) || !delegable.has(g) || OWNER_ONLY.includes(g as Capability));
}

/** Who can assign which roles. Owner assignment is never possible through this path. */
export function canAssignRole(actorRole: TenantRole, actorCaps: ReadonlySet<Capability>, target: TenantRole): boolean {
  if (target === 'owner') return false;
  if (actorRole === 'owner') return true;
  // A delegated manager can manage non-manager staff, never peers or owners.
  return actorCaps.has('team.manage') && target !== 'manager';
}

/**
 * Capabilities the resulting membership would hold that the acting non-owner does
 * not hold. Non-owners can never hand out more than they have (e.g. a manager with
 * only team.manage cannot create a finance user). Owners are unrestricted here.
 */
export function capabilitiesBeyondActor(actorRole: TenantRole, actorCaps: ReadonlySet<Capability>, target: TenantRole, granted: readonly string[] = [], revoked: readonly string[] = []): Capability[] {
  if (actorRole === 'owner') return [];
  return [...effectiveCapabilities(target, granted, revoked)].filter((c) => !actorCaps.has(c) && !SELF_SCOPED.has(c));
}

/** Capabilities that only ever reach the holder's own records; handing them out grants nothing over others. */
const SELF_SCOPED = new Set<Capability>(['bookings.view_assigned', 'bookings.manage_assigned', 'schedule.view_own', 'leave.request', 'attendance.own', 'staff.edit_own_profile']);

// ── Support access ──────────────────────────────────────────────────────────
/** Capabilities a LUMA support user gets through a time-limited grant. */
export function supportCapabilities(level: 'read' | 'write'): Set<Capability> {
  const read: Capability[] = [
    'bookings.view_all', 'customers.view', 'orders.view', 'inventory.view', 'finance.view', 'analytics.view',
    'marketing.view', 'subscription.view', 'audit.view', 'bookings.view_financial',
  ];
  if (level === 'read') return new Set(read);
  return new Set<Capability>([
    ...read, 'builder.edit', 'builder.publish', 'catalog.edit', 'staff.edit', 'bookings.manage', 'schedule.manage',
  ]);
}

// ── Platform administration ─────────────────────────────────────────────────
export const PLATFORM_ROLES = ['platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_CAPABILITIES = [
  'platform.tenants.view',
  'platform.tenants.manage',
  'platform.plans.manage',
  'platform.subscriptions.manage',
  'platform.users.manage',
  'platform.roles.manage',
  'platform.templates.manage',
  'platform.policy.review',
  'platform.audit.view',
  'platform.integrations.view',
  'platform.ai_usage.view',
  'platform.revenue.view',
  'platform.support.access',
] as const;
export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

const PLATFORM_ROLE_CAPS: Record<PlatformRole, readonly PlatformCapability[]> = {
  platform_owner: PLATFORM_CAPABILITIES,
  support_admin: ['platform.tenants.view', 'platform.support.access', 'platform.audit.view', 'platform.integrations.view'],
  policy_reviewer: ['platform.tenants.view', 'platform.policy.review'],
  technical_admin: ['platform.tenants.view', 'platform.integrations.view', 'platform.ai_usage.view', 'platform.audit.view'],
};

export function platformCapabilities(roles: readonly string[]): Set<PlatformCapability> {
  const caps = new Set<PlatformCapability>();
  for (const r of roles) {
    const list = PLATFORM_ROLE_CAPS[r as PlatformRole];
    if (list) for (const c of list) caps.add(c);
  }
  return caps;
}
