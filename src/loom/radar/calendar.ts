import { createHash } from 'node:crypto';
import { audit, Errors, sql, withSystem, withTenant, type AuditActor, type Tx } from '../db';
import type { CalendarEvent } from '../contracts/canonical';
import { readPlatformSettings, type LoomPlatformSettings } from '../settings/platform';
import { sectorPack } from '../sector/beauty';
import { L, render, type Localized, type LoomLocale } from '../util/text';
import { addDays, localToday } from '../util/time';
import { SA_STARTER_CALENDAR } from './calendar-sa';
import { businessContext } from './context';
import { parseCalendar } from './parse';
import { radarFetcher } from './ports';
import { eventRelevance, regionFit, type RelevanceContext } from './relevance';
import { detectHealthTopics, isAwarenessOnly } from './topics';
import { RadarFetchError, type CalendarKind, type Relevance } from './types';

/**
 * Platform calendar (§12.1 official calendars). Three origins:
 *   starter          curated SA reference data (calendar-sa.ts) with explicit
 *                    attribution and needs_verification for estimates;
 *   official_source  imported from the platform owner's registry
 *                    (platform setting event_sources) through the host's
 *                    SSRF-safe fetcher; titles are untrusted text;
 *   platform_manual  reserved.
 * A platform owner can verify (with a note and corrected dates), withdraw or
 * restore an event. Businesses adopt or hide events; owner-verified events
 * of the business (LUMA marketing calendar, via the connector) remain.
 */
type SourceDef = LoomPlatformSettings['event_sources'][number];
const KIND_OF_SOURCE: Record<SourceDef['kind'], CalendarKind> = { official_calendar: 'national', school_calendar: 'school_holiday', religious_calendar: 'religious', other: 'local_event' };
const REGION_RE = /^(GLOBAL|SA|SA:[a-z_]{2,30})$/;
const normRegion = (r: string | null | undefined, fallback: string) => {
  const x = (r ?? '').trim();
  if (REGION_RE.test(x)) return x;
  if (/^SA:/i.test(x)) { const c = x.slice(3).toLowerCase().replace(/[^a-z_]/g, ''); if (c.length >= 2) return `SA:${c}`; }
  return REGION_RE.test(fallback) ? fallback : 'SA';
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HOUR = 3_600_000;
/** Exponential backoff after failures: 1h, 2h, 4h … capped at 24h. */
export const backoffMs = (failures: number) => Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, failures - 1));

/** Idempotent: inserts missing starter events; never overwrites a reviewed or withdrawn one. */
export async function ensureStarterCalendar(trx?: Tx): Promise<number> {
  const run = async (t: Tx) => {
    let n = 0;
    for (const e of SA_STARTER_CALENDAR) {
      const r = await t.insertInto('loom.platform_calendar_events').values({
        event_key: e.key, origin: 'starter', source_name: e.source_name, source_url: e.source_url, kind: e.kind, region: e.region, title_ar: e.title_ar, title_en: e.title_en,
        starts_on: e.starts_on, ends_on: e.ends_on, date_basis: e.date_basis, needs_verification: e.needs_verification, topics: e.topics,
      }).onConflict((oc) => oc.column('event_key').doNothing()).returning('id').executeTakeFirst();
      if (r) n++;
    }
    return n;
  };
  return trx ? run(trx) : withSystem('loom: starter calendar', run);
}

/** Imports one registry source. Success/failure and backoff are kept in official_source_state. */
export async function importOfficialSource(src: SourceDef, now = new Date()): Promise<{ ok: boolean; error: string | null; imported: number; unchanged: boolean }> {
  const state = await withSystem('loom: source state', (trx) => trx.selectFrom('loom.official_source_state').selectAll().where('source_id', '=', src.id).executeTakeFirst());
  let text: string, contentType: string;
  try {
    const res = await radarFetcher().fetch(src.url, 'calendar');
    text = res.text; contentType = res.contentType;
  } catch (e) {
    const code = e instanceof RadarFetchError ? e.code : 'network_error';
    const failures = (state?.consecutive_failures ?? 0) + 1;
    await withSystem('loom: source state', (trx) => trx.insertInto('loom.official_source_state')
      .values({ source_id: src.id, status: 'error', last_fetched_at: now, last_error: code, consecutive_failures: failures, next_fetch_at: new Date(now.getTime() + backoffMs(failures)), updated_at: now })
      .onConflict((oc) => oc.column('source_id').doUpdateSet({ status: 'error', last_fetched_at: now, last_error: code, consecutive_failures: failures, next_fetch_at: new Date(now.getTime() + backoffMs(failures)), updated_at: now }))
      .execute());
    return { ok: false, error: code, imported: 0, unchanged: false };
  }
  const hash = sha(text);
  const events = parseCalendar(text, contentType);
  const today = now.toISOString().slice(0, 10);
  let imported = 0;
  await withSystem('loom: import official calendar', async (trx) => {
    if (hash !== state?.last_hash) {
      for (const ev of events) {
        if (ev.ends_on < addDays(today, -30) || ev.starts_on > addDays(today, 400)) continue;
        const topics = detectHealthTopics(`${ev.untrusted_title} ${ev.untrusted_description ?? ''}`);
        const kind: CalendarKind = topics.length ? 'health_awareness' : KIND_OF_SOURCE[src.kind];
        const key = `${src.id}:${(ev.uid ? sha(ev.uid) : sha(`${ev.untrusted_title}|${ev.starts_on}`)).slice(0, 32)}`;
        const values = {
          origin: 'official_source', source_id: src.id, source_name: src.name, source_url: src.url, source_ref: ev.uid, kind, region: normRegion(ev.region, src.region),
          untrusted_title: ev.untrusted_title, untrusted_description: ev.untrusted_description, starts_on: ev.starts_on, ends_on: ev.ends_on,
          date_basis: 'official_source', needs_verification: src.kind === 'other', topics,
        } as const;
        const r = await trx.insertInto('loom.platform_calendar_events').values({ event_key: key, ...values, topics: [...topics] })
          .onConflict((oc) => oc.column('event_key').doUpdateSet({ ...values, topics: [...topics] }).where('loom.platform_calendar_events.date_basis', '<>', 'platform_verified'))
          .returning('id').executeTakeFirst();
        if (r) imported++;
      }
    }
    const v = { status: 'ok', last_fetched_at: now, last_success_at: now, last_error: events.length ? null : 'no_events', consecutive_failures: 0, next_fetch_at: new Date(now.getTime() + 24 * HOUR), imported_count: imported, last_hash: hash, updated_at: now };
    await trx.insertInto('loom.official_source_state').values({ source_id: src.id, ...v }).onConflict((oc) => oc.column('source_id').doUpdateSet(v)).execute();
  });
  return { ok: true, error: null, imported, unchanged: hash === state?.last_hash };
}

/** Periodic: starter calendar + every enabled registry source that is due. */
export async function importDueOfficialSources(now = new Date()) {
  await ensureStarterCalendar();
  const settings = await withSystem('loom: settings', (trx) => readPlatformSettings(trx));
  const states = await withSystem('loom: source state', (trx) => trx.selectFrom('loom.official_source_state').selectAll().execute());
  const out: Array<{ id: string; ok: boolean; error: string | null }> = [];
  for (const s of settings.event_sources) {
    const st = states.find((x) => x.source_id === s.id);
    if (!s.enabled) {
      if (st && st.status !== 'disabled') await withSystem('loom: source state', (trx) => trx.updateTable('loom.official_source_state').set({ status: 'disabled', updated_at: now }).where('source_id', '=', s.id).execute());
      continue;
    }
    if (st && st.status !== 'disabled' && st.next_fetch_at.getTime() > now.getTime()) continue;
    const r = await importOfficialSource(s, now);
    out.push({ id: s.id, ok: r.ok, error: r.error });
  }
  return out;
}

// ── Views ────────────────────────────────────────────────────────────────────
type EventRow = { id: string; event_key: string; origin: string; source_id: string | null; source_name: string; source_url: string | null; kind: string; region: string; title_ar: string | null; title_en: string | null;
  untrusted_title: string | null; untrusted_description: string | null; starts_on: string; ends_on: string; date_basis: string; needs_verification: boolean; verified_at: Date | null; verification_note: string | null; topics: string[]; status: string };

export const eventTitle = (e: Pick<EventRow, 'title_ar' | 'title_en' | 'untrusted_title'>): { title: Localized; untrusted: boolean } =>
  (e.title_ar || e.title_en ? { title: L(e.title_ar ?? e.title_en ?? '', e.title_en ?? e.title_ar ?? ''), untrusted: false } : { title: L(e.untrusted_title ?? '', e.untrusted_title ?? ''), untrusted: true });

/** verified ⇔ the date is not an estimate (official source, fixed rule or platform-verified). Never derived from the title. */
export const verificationOf = (e: Pick<EventRow, 'needs_verification'>) => (e.needs_verification ? 'needs_verification' as const : 'verified' as const);

export async function platformCalendar(opts: { from?: string; to?: string; now?: Date } = {}) {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  return withSystem('loom: platform calendar', async (trx) => {
    const settings = await readPlatformSettings(trx);
    const events = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('ends_on', '>=', opts.from ?? addDays(today, -30)).where('starts_on', '<=', opts.to ?? addDays(today, 400))
      .orderBy('starts_on').orderBy('event_key').execute();
    const states = await trx.selectFrom('loom.official_source_state').selectAll().execute();
    return {
      sources: settings.event_sources.map((s) => ({ ...s, state: states.find((x) => x.source_id === s.id) ?? null })),
      events: events.map((e) => ({ ...e, ...eventTitle(e), verification: verificationOf(e) })),
    };
  });
}

export type ReviewInput = { action: 'verify'; note: string; starts_on?: string; ends_on?: string } | { action: 'withdraw'; note?: string } | { action: 'restore' };

/** Platform owner review: verification needs a note (e.g. the official announcement) and may correct the dates. */
export async function reviewPlatformEvent(actor: AuditActor, id: string, input: ReviewInput) {
  return withSystem('loom: review calendar event', async (trx) => {
    const e = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!e) throw Errors.notFound('calendar_event');
    if (input.action === 'verify') {
      const starts = input.starts_on ?? e.starts_on, ends = input.ends_on ?? (input.starts_on && e.ends_on < input.starts_on ? input.starts_on : e.ends_on);
      if (ends < starts) throw Errors.invalid('invalid_dates', 'ends_on must be on or after starts_on');
      await trx.updateTable('loom.platform_calendar_events').set({ date_basis: 'platform_verified', needs_verification: false, verified_by: actor.userId, verified_at: new Date(), verification_note: input.note, starts_on: starts, ends_on: ends }).where('id', '=', id).execute();
    } else {
      await trx.updateTable('loom.platform_calendar_events').set({ status: input.action === 'withdraw' ? 'withdrawn' : 'active' }).where('id', '=', id).execute();
    }
    await audit(trx, actor, 'loom.calendar_event_reviewed', { targetType: 'loom_calendar_event', targetId: id, data: { action: input.action, before: { starts_on: e.starts_on, ends_on: e.ends_on, needs_verification: e.needs_verification, status: e.status } } });
    const after = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    return { ...after, ...eventTitle(after), verification: verificationOf(after) };
  });
}

// ── Business calendar ───────────────────────────────────────────────────────
export type BusinessCalendarItem = {
  ref: string; id: string; origin: 'platform_calendar' | 'owner_calendar'; title: string; title_is_untrusted: boolean; kind: string; region: string | null;
  starts_on: string; ends_on: string; verification: 'verified' | 'needs_verification'; date_basis: string; awareness_only: boolean;
  choice: 'adopted' | 'hidden' | null; source: { name: string; url: string | null }; relevance: { score: number; reasons: string[]; opportunity_id: string | null } | null;
  attached_opportunity_ids: string[];
};

const renderRel = (r: Relevance, locale: LoomLocale) => ({ score: r.score, reasons: r.reasons.map((x) => render(x, locale)), opportunity_id: r.opportunity_id });

/** Active platform events relevant to the business area (other local areas are left out). */
export async function relevantPlatformEvents(trx: Tx, from: string, to: string, city: string | null) {
  const rows = await trx.selectFrom('loom.platform_calendar_events').selectAll().where('status', '=', 'active').where('ends_on', '>=', from).where('starts_on', '<=', to).orderBy('starts_on').orderBy('event_key').execute();
  return rows.filter((e) => regionFit(e.region, city).fit > 0);
}

export async function businessCalendar(businessId: string, locale: LoomLocale, opts: { now?: Date; days?: number } = {}): Promise<BusinessCalendarItem[]> {
  const { business, ownerEvents, rc } = await businessContext(businessId);
  const today = localToday(business?.timezone ?? 'Asia/Riyadh', opts.now);
  const to = addDays(today, opts.days ?? 365);
  const pack = sectorPack(rc.packId);
  return withTenant(businessId, async (trx) => {
    const events = await relevantPlatformEvents(trx, today, to, rc.city);
    const choices = await trx.selectFrom('loom.calendar_choices').select(['event_id', 'choice']).where('business_id', '=', businessId).execute();
    const att = await trx.selectFrom('loom.timing_attachments').select(['ref_kind', 'ref_id', 'opportunity_id']).where('business_id', '=', businessId).where('detached_at', 'is', null).execute();
    const attachedTo = (kind: string, id: string) => att.filter((a) => a.ref_kind === kind && a.ref_id === id).map((a) => a.opportunity_id);
    const out: BusinessCalendarItem[] = events.map((e) => {
      const aw = isAwarenessOnly(e, pack);
      const t = eventTitle(e);
      return {
        ref: `platform:${e.id}`, id: e.id, origin: 'platform_calendar', title: render(t.title, locale), title_is_untrusted: t.untrusted, kind: e.kind, region: e.region,
        starts_on: e.starts_on, ends_on: e.ends_on, verification: verificationOf(e), date_basis: e.date_basis, awareness_only: aw,
        choice: (choices.find((c) => c.event_id === e.id)?.choice ?? null) as 'adopted' | 'hidden' | null, source: { name: e.source_name, url: e.source_url },
        relevance: renderRel(eventRelevance({ kind: e.kind, region: e.region, starts_on: e.starts_on, topics: e.topics, awareness_only: aw }, rc), locale),
        attached_opportunity_ids: attachedTo('platform_event', e.id),
      };
    });
    for (const e of ownerEvents.filter((x) => x.ends_on >= today && x.starts_on <= to)) {
      out.push({
        ref: `owner:${e.id}`, id: e.id, origin: 'owner_calendar', title: e.title, title_is_untrusted: false, kind: e.kind, region: null, starts_on: e.starts_on, ends_on: e.ends_on,
        verification: 'verified', date_basis: 'owner_verified', awareness_only: false, choice: 'adopted', source: { name: 'owner', url: null },
        relevance: renderRel(eventRelevance({ kind: e.kind, region: null, starts_on: e.starts_on, topics: [], awareness_only: false }, rc), locale),
        attached_opportunity_ids: attachedTo('owner_event', e.id),
      });
    }
    return out.sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.ref.localeCompare(b.ref));
  });
}

export async function setCalendarChoice(c: { businessId: string; actor: AuditActor }, eventId: string, choice: 'adopted' | 'hidden' | null) {
  return withTenant(c.businessId, async (trx) => {
    const e = await trx.selectFrom('loom.platform_calendar_events').select(['id', 'status']).where('id', '=', eventId).executeTakeFirst();
    if (!e || e.status !== 'active') throw Errors.notFound('calendar_event');
    if (choice === null) await trx.deleteFrom('loom.calendar_choices').where('business_id', '=', c.businessId).where('event_id', '=', eventId).execute();
    else await trx.insertInto('loom.calendar_choices').values({ business_id: c.businessId, event_id: eventId, choice, decided_by: c.actor.userId, decided_at: new Date() })
      .onConflict((oc) => oc.columns(['business_id', 'event_id']).doUpdateSet({ choice, decided_by: c.actor.userId, decided_at: new Date() })).execute();
    await audit(trx, c.actor, 'loom.calendar_choice', { tenantId: c.businessId, targetType: 'loom_calendar_event', targetId: eventId, data: { choice } });
    return { event_id: eventId, choice };
  });
}

/**
 * Platform events a business ADOPTED, as canonical calendar events for the
 * engine's timing rule: verified only when the date is verified, awareness
 * flag from the sector pack. Hidden or unadopted events are not used.
 */
export async function adoptedEvents(trx: Tx, businessId: string, from: string, to: string, packId: string): Promise<Array<CalendarEvent & { awareness_only: boolean }>> {
  const rows = await trx.selectFrom('loom.calendar_choices as c').innerJoin('loom.platform_calendar_events as e', 'e.id', 'c.event_id')
    .select(['e.id', 'e.title_ar', 'e.title_en', 'e.untrusted_title', 'e.kind', 'e.starts_on', 'e.ends_on', 'e.needs_verification', 'e.source_url', 'e.topics'])
    .where('c.business_id', '=', businessId).where('c.choice', '=', 'adopted').where('e.status', '=', 'active').where('e.ends_on', '>=', from).where('e.starts_on', '<=', to)
    .orderBy('e.starts_on').execute();
  const pack = sectorPack(packId);
  return rows.map((e) => ({ id: e.id, title: e.title_ar ?? e.title_en ?? e.untrusted_title ?? '', kind: e.kind, starts_on: e.starts_on, ends_on: e.ends_on, verified: !e.needs_verification, has_source: !!e.source_url, awareness_only: isAwarenessOnly(e, pack) }));
}

/** For tests and the platform page: drop official-source state (forces a re-import). */
export async function resetOfficialSourceState(sourceId?: string) {
  await withSystem('loom: reset source state', (trx) => (sourceId ? sql`delete from loom.official_source_state where source_id = ${sourceId}` : sql`delete from loom.official_source_state`).execute(trx));
}
