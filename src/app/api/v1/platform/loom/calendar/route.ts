import { platformRoute } from '@/server/domains/platform/guard';
import { Errors } from '@/server/http/errors';
import { ensureStarterCalendar, getPlatformSettings, importOfficialSource, platformCalendar, platformCalendarImportInput } from '@/loom';
import '@/server/loom-host/radar';

/** GET /api/v1/platform/loom/calendar — the platform calendar and the official sources' fetch state (platform owner). */
export const GET = platformRoute({
  platformCapability: 'platform.loom.manage',
  handler: async () => ({ data: await platformCalendar() }),
});

/** POST — import now: { target: 'starter' } (curated SA reference data) or { target: 'sources', source_id? } (registry, safe-fetch). */
export const POST = platformRoute({
  platformCapability: 'platform.loom.manage', stepUp: true, input: platformCalendarImportInput,
  handler: async ({ input }) => {
    if (input.target === 'starter') return { data: { starter_inserted: await ensureStarterCalendar() } };
    const { event_sources } = await getPlatformSettings();
    const list = event_sources.filter((s) => s.enabled && (!input.source_id || s.id === input.source_id));
    if (input.source_id && !list.length) throw Errors.notFound('event_source');
    const results = [];
    for (const s of list) results.push({ id: s.id, ...(await importOfficialSource(s)) });
    return { data: { results } };
  },
});
