/**
 * Workspace profile per business type: which i18n keys get a type-specific
 * label and which navigation items are hidden. Salons (and any type without
 * a profile) get the identity profile, so they are unaffected.
 *
 * Labels are an i18n key → i18n key map: the workspace shell applies it to
 * every `t()` call under it (nav, page titles, tabs), so a page never needs to
 * know which business type it is rendered for.
 */
export type WorkspaceProfile = {
  /** Original i18n key → replacement i18n key. */
  labels: Readonly<Record<string, string>>;
  /** Navigation item keys hidden for this business type. */
  hiddenNav: readonly string[];
};

const IDENTITY: WorkspaceProfile = { labels: {}, hiddenNav: [] };

const EXPERT: WorkspaceProfile = {
  labels: {
    // Navigation
    'nav.bookings': 'expert.nav.bookings',
    'nav.customers': 'expert.nav.customers',
    'nav.services': 'expert.nav.services',
    'nav.products': 'expert.nav.products',
    'nav.team': 'expert.nav.team',
    'nav.builder': 'expert.nav.builder',
    'nav.portfolio': 'expert.nav.portfolio',
    'nav.me': 'expert.nav.me',
    // Page titles
    'booking.dashboard.title': 'expert.titles.bookings',
    'customers.title': 'expert.titles.customers',
    'catalog_ui.services_title': 'expert.titles.services',
    'commerce.products.title': 'expert.titles.products',
    'team_ui.title': 'expert.titles.team',
    'catalog_team.team.subtitle': 'expert.titles.team_subtitle',
    'expert.portfolio.title': 'expert.titles.portfolio',
    'builder.o.portfolio': 'expert.ba.o_portfolio',
    // A solo expert works from one studio rather than managing branches.
    'biz_settings.tabs.branches': 'expert.titles.studio',
  },
  // Group classes are a salon/academy concept; experts sell event bookings instead.
  hiddenNav: ['groups'],
};

export const WORKSPACE_PROFILES: Readonly<Record<string, WorkspaceProfile>> = { expert: EXPERT };

export function workspaceProfile(businessType: string | null | undefined): WorkspaceProfile {
  return (businessType && WORKSPACE_PROFILES[businessType]) || IDENTITY;
}

/** The i18n key to use for `key` in this business type's workspace. */
export function workspaceLabelKey(businessType: string | null | undefined, key: string): string {
  return workspaceProfile(businessType).labels[key] ?? key;
}

/** Wraps a translate function with the business type's label map. */
export function withWorkspaceLabels<T extends (key: string, vars?: Record<string, string | number>) => string>(t: T, businessType: string | null | undefined): T {
  const labels = workspaceProfile(businessType).labels;
  if (!Object.keys(labels).length) return t;
  return ((key: string, vars?: Record<string, string | number>) => t(labels[key] ?? key, vars)) as T;
}
