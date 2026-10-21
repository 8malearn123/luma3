import { describe, expect, it } from 'vitest';
import { canAssignRole, effectiveCapabilities, invalidGrants, platformCapabilities, supportCapabilities } from '@/server/auth/capabilities';

describe('capability model (permissions matrix)', () => {
  it('receptionist cannot view costs or edit the storefront by default', () => {
    const caps = effectiveCapabilities('receptionist');
    expect(caps.has('costs.view')).toBe(false);
    expect(caps.has('builder.edit')).toBe(false);
    expect(caps.has('bookings.manage')).toBe(true);
    expect(caps.has('payments.collect')).toBe(true);
  });

  it('specialist only manages assigned bookings and own profile fields', () => {
    const caps = effectiveCapabilities('specialist');
    expect(caps.has('bookings.view_all')).toBe(false);
    expect(caps.has('bookings.view_assigned')).toBe(true);
    expect(caps.has('staff.edit')).toBe(false);
    expect(caps.has('staff.edit_own_profile')).toBe(true);
  });

  it('manager gets delegated capabilities only from the allowlist', () => {
    const caps = effectiveCapabilities('manager', ['builder.publish', 'campaigns.approve', 'subscription.manage', 'business.manage', 'made.up']);
    expect(caps.has('builder.publish')).toBe(true);
    expect(caps.has('campaigns.approve')).toBe(true);
    expect(caps.has('subscription.manage')).toBe(false);
    expect(caps.has('business.manage')).toBe(false);
    expect(invalidGrants('manager', ['builder.publish', 'subscription.manage', 'made.up'])).toEqual(['subscription.manage', 'made.up']);
  });

  it('finance sees costs/finance but cannot approve campaigns', () => {
    const caps = effectiveCapabilities('finance');
    expect(caps.has('costs.view')).toBe(true);
    expect(caps.has('refunds.approve')).toBe(true);
    expect(caps.has('campaigns.approve')).toBe(false);
  });

  it('owner revocations are ignored; others can be revoked', () => {
    expect(effectiveCapabilities('owner', [], ['builder.publish']).has('builder.publish')).toBe(true);
    expect(effectiveCapabilities('receptionist', [], ['bookings.manage']).has('bookings.manage')).toBe(false);
  });

  it('nobody can assign the owner role; managers cannot assign managers', () => {
    const mgr = effectiveCapabilities('manager', ['team.manage']);
    expect(canAssignRole('owner', effectiveCapabilities('owner'), 'owner')).toBe(false);
    expect(canAssignRole('manager', mgr, 'receptionist')).toBe(true);
    expect(canAssignRole('manager', mgr, 'manager')).toBe(false);
    expect(canAssignRole('receptionist', effectiveCapabilities('receptionist'), 'specialist')).toBe(false);
  });

  it('platform capabilities follow least privilege and tenant roles grant none', () => {
    expect(platformCapabilities(['policy_reviewer']).has('platform.policy.review')).toBe(true);
    expect(platformCapabilities(['support_admin']).has('platform.policy.review')).toBe(false);
    expect(platformCapabilities(['owner', 'manager']).size).toBe(0);
  });

  it('read-only support access cannot publish', () => {
    expect(supportCapabilities('read').has('builder.publish')).toBe(false);
    expect(supportCapabilities('write').has('builder.publish')).toBe(true);
    expect(supportCapabilities('write').has('costs.view')).toBe(false);
  });
});
