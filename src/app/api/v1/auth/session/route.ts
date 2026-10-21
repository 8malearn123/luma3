import { sql } from 'kysely';
import { route } from '@/server/http/route';
import { db } from '@/server/db/client';
import { platformCapabilities } from '@/server/auth/capabilities';
import { env } from '@/server/env';

/** GET /api/v1/auth/session — the current user, memberships (business selector) and platform capabilities. */
export const GET = route({
  auth: 'optional',
  handler: async ({ user }) => {
    if (!user) return { data: { user: null, demo_mode: env().demoEnabled } };
    const memberships = await sql<{ tenant_slug: string; tenant_name: string; role: string; tenant_status: string; business_type: string }>`
      select tenant_slug, tenant_name, role, tenant_status, business_type from app.memberships_for_user(${user.userId})`.execute(db());
    return {
      data: {
        user: {
          id: user.userId, display_name: user.displayName, email: user.email, phone: user.phone,
          email_verified: user.emailVerified, phone_verified: user.phoneVerified, locale: user.locale, time_format: user.timeFormat,
          is_demo: user.isDemo,
        },
        memberships: memberships.rows,
        platform_capabilities: [...platformCapabilities(user.platformRoles)],
        demo_mode: env().demoEnabled,
      },
    };
  },
});
