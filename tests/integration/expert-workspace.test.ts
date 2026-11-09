import { describe, expect, it } from 'vitest';
import { createBusinessFor, signup } from '../helpers/factory';
import { resolveTenantAccess } from '@/server/tenancy/access';
import { resolveSession, SESSION_COOKIE } from '@/server/auth/service';
import { translate } from '@/i18n';
import { visibleNav } from '@/ui/shell/nav';
import { WORKSPACE_PROFILES, withWorkspaceLabels, workspaceLabelKey, workspaceProfile } from '@/shared/workspace-profile';

type Access = Parameters<typeof visibleNav>[0];
const ALL_CAPS = ['inventory.view', 'inventory.manage', 'bookings.manage', 'bookings.view_all', 'catalog.edit', 'builder.edit', 'staff.edit', 'customers.view', 'orders.view', 'finance.view'];
const access = (businessType: string, features: Record<string, boolean> = {}): Access => ({
  businessType, capabilities: ALL_CAPS,
  plan: { code: 'wahaj', status: 'active', features: Object.fromEntries(Object.entries({ 'feature.inventory': true, 'feature.products': true, 'feature.group_sessions': true, ...features }).map(([k, v]) => [k, { enabled: v, limit: null }])) },
} as unknown as Access);
const keys = (a: Access) => visibleNav(a).map((n) => n.key);

describe('expert workspace: label map per business type', () => {
  it('relabels nav and page titles for experts only', () => {
    const tE = withWorkspaceLabels((k: string) => translate('ar', k), 'expert');
    const tS = withWorkspaceLabels((k: string) => translate('ar', k), 'salon');
    expect(tE('nav.portfolio')).toBe('أعمالي');
    expect(tE('nav.builder')).toBe('متجري');
    expect(tE('nav.services')).toBe('خدماتي');
    expect(tE('nav.customers')).toBe('عميلاتي');
    expect(tE('catalog_ui.services_title')).toBe('خدماتي');
    expect(tE('customers.title')).toBe('عميلاتي');
    expect(tS('nav.services')).toBe(translate('ar', 'nav.services'));
    expect(tS('nav.builder')).toBe(translate('ar', 'nav.builder'));
    for (const bt of ['salon', 'beauty_center', 'spa', null, undefined]) expect(workspaceProfile(bt).labels).toEqual({});
    expect(workspaceLabelKey('salon', 'nav.services')).toBe('nav.services');
    // English mirrors the map.
    expect(withWorkspaceLabels((k: string) => translate('en', k), 'expert')('nav.builder')).toBe('My store');
  });

  it('every mapped key resolves in both languages', () => {
    for (const p of Object.values(WORKSPACE_PROFILES)) {
      for (const [from, to] of Object.entries(p.labels)) {
        for (const l of ['ar', 'en'] as const) {
          expect(translate(l, to), `${l}:${to}`).not.toBe(to);
          expect(translate(l, from), `${l}:${from}`).not.toBe(from);
        }
      }
    }
  });
});

describe('expert workspace: navigation rules', () => {
  it('shows inventory to experts (with the plan feature) and hides group classes', () => {
    const e = keys(access('expert'));
    expect(e).toContain('inventory');
    expect(e).toContain('events');
    expect(e).toContain('portfolio');
    expect(e).toContain('team'); // assistants
    expect(e).not.toContain('groups');
    expect(keys(access('expert', { 'feature.inventory': false }))).not.toContain('inventory');
  });

  it('leaves salons unchanged (groups and inventory visible)', () => {
    const s = keys(access('salon'));
    expect(s).toContain('groups');
    expect(s).toContain('inventory');
  });

  it('a real expert business gets the expert profile through its access', async () => {
    const owner = await signup('Expert');
    const biz = await createBusinessFor(owner, { business_type: 'expert', plan_code: 'wahaj' });
    const user = (await resolveSession(owner.cookies.get(SESSION_COOKIE)))!;
    const t = await resolveTenantAccess(user, biz.slug);
    expect(t.businessType).toBe('expert');
    const a = { businessType: t.businessType, capabilities: [...t.capabilities], plan: { features: Object.fromEntries(t.plan.features) } } as unknown as Access;
    const nav = keys(a);
    expect(nav).not.toContain('groups');
    expect(nav).toContain('events');
    expect(nav).toContain('portfolio');
  });
});
