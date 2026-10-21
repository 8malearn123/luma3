import type { ClientAccess } from '@/server/pages';

export type NavItem = {
  key: string;
  href: (slug: string) => string;
  icon: string;
  /** Any of these capabilities shows the item. */
  caps: string[];
  feature?: string;
  /** Hidden for these business types (independent experts get a lighter workspace). */
  hideFor?: string[];
  section: 'operate' | 'sell' | 'grow' | 'configure';
};

export const NAV: NavItem[] = [
  { key: 'overview', href: (s) => `/app/${s}`, icon: 'LayoutDashboard', caps: [], section: 'operate' },
  { key: 'bookings', href: (s) => `/app/${s}/bookings`, icon: 'CalendarDays', caps: ['bookings.view_all', 'bookings.view_assigned', 'bookings.view_financial'], section: 'operate' },
  { key: 'customers', href: (s) => `/app/${s}/customers`, icon: 'Contact', caps: ['customers.view'], section: 'operate' },
  { key: 'waitlist', href: (s) => `/app/${s}/waitlist`, icon: 'ListOrdered', caps: ['waitlist.manage'], feature: 'feature.waitlist', section: 'operate' },
  { key: 'groups', href: (s) => `/app/${s}/groups`, icon: 'UsersRound', caps: ['bookings.manage'], feature: 'feature.group_sessions', hideFor: ['expert'], section: 'operate' },
  { key: 'team', href: (s) => `/app/${s}/team`, icon: 'Users', caps: ['staff.edit', 'schedule.manage', 'team.manage', 'leave.approve'], section: 'operate' },
  { key: 'policies', href: (s) => `/app/${s}/policies`, icon: 'ShieldAlert', caps: ['incidents.submit', 'incidents.review'], section: 'operate' },

  { key: 'services', href: (s) => `/app/${s}/services`, icon: 'Sparkles', caps: ['catalog.edit'], section: 'sell' },
  { key: 'products', href: (s) => `/app/${s}/products`, icon: 'ShoppingBag', caps: ['catalog.edit', 'inventory.manage'], feature: 'feature.products', section: 'sell' },
  { key: 'orders', href: (s) => `/app/${s}/orders`, icon: 'Receipt', caps: ['orders.view'], feature: 'feature.products', section: 'sell' },
  { key: 'inventory', href: (s) => `/app/${s}/inventory`, icon: 'Boxes', caps: ['inventory.view', 'inventory.manage'], feature: 'feature.inventory', hideFor: ['expert'], section: 'sell' },
  { key: 'finance', href: (s) => `/app/${s}/finance`, icon: 'Landmark', caps: ['finance.view'], section: 'sell' },

  { key: 'marketing', href: (s) => `/app/${s}/marketing`, icon: 'Lightbulb', caps: ['marketing.view', 'marketing.manage'], feature: 'feature.marketing_ai', section: 'grow' },
  { key: 'analytics', href: (s) => `/app/${s}/analytics`, icon: 'ChartLine', caps: ['analytics.view'], section: 'grow' },
  { key: 'loyalty', href: (s) => `/app/${s}/loyalty`, icon: 'Gem', caps: ['loyalty.manage'], feature: 'feature.loyalty', section: 'grow' },
  { key: 'gifts', href: (s) => `/app/${s}/gifts`, icon: 'Gift', caps: ['giftcards.manage'], feature: 'feature.gift_cards', section: 'grow' },
  { key: 'memberships', href: (s) => `/app/${s}/memberships`, icon: 'BadgeCheck', caps: ['memberships.manage'], feature: 'feature.memberships', section: 'grow' },

  { key: 'builder', href: (s) => `/app/${s}/builder`, icon: 'Palette', caps: ['builder.edit'], section: 'configure' },
  { key: 'settings', href: (s) => `/app/${s}/settings`, icon: 'Settings', caps: ['business.manage', 'payments.configure', 'subscription.view'], section: 'configure' },
  { key: 'audit', href: (s) => `/app/${s}/audit`, icon: 'ScrollText', caps: ['audit.view'], section: 'configure' },
];

export function visibleNav(access: ClientAccess) {
  const caps = new Set(access.capabilities);
  return NAV.filter((n) =>
    (n.caps.length === 0 || n.caps.some((c) => caps.has(c)))
    && (!n.feature || access.plan.features[n.feature]?.enabled)
    && !(n.hideFor ?? []).includes(access.businessType));
}
