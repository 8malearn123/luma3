import { z } from 'zod';
import type { AuditActor } from '../db';
import type { LoomLocale } from '../util/text';
import { businessCalendar, reviewPlatformEvent, setCalendarChoice, type ReviewInput } from './calendar';
import { addMarketObservation, listMarketObservations, updateMarketObservation } from './market';
import { addSource, assessClusters, fetchSource, radarView, updateSource } from './sources';
import { attachTiming, decideCluster, detachTiming } from './timing';

/** Loom radar API v1 (host-agnostic). Request schemas are shared with the routes and the UI. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const signalSourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rss'), name: z.string().trim().min(2).max(120), url: z.string().url().max(500).regex(/^https:\/\//), access_basis: z.string().trim().min(2).max(300) }).strict(),
  z.object({ kind: z.literal('user_link'), name: z.string().trim().min(2).max(120), url: z.string().url().max(500).regex(/^https:\/\//), access_basis: z.string().trim().min(2).max(300) }).strict(),
  z.object({ kind: z.literal('api'), name: z.string().trim().min(2).max(120), provider: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), query: z.object({ q: z.string().trim().max(120).optional(), region: z.string().trim().max(40).optional() }).strict().default({}), access_basis: z.string().trim().min(2).max(300) }).strict(),
]);
export const signalSourcePatch = z.object({ status: z.enum(['active', 'disabled']) }).strict();
export const clusterDecisionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss') }).strict(),
  z.object({ action: z.literal('reopen') }).strict(),
  z.object({ action: z.literal('attach'), opportunity_id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('detach') }).strict(),
  z.object({ action: z.literal('add_to_plan') }).strict(),
]);
export const calendarActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('adopt') }).strict(),
  z.object({ action: z.literal('hide') }).strict(),
  z.object({ action: z.literal('reset') }).strict(),
  z.object({ action: z.literal('attach'), opportunity_id: z.string().uuid(), origin: z.enum(['platform', 'owner']).default('platform') }).strict(),
  z.object({ action: z.literal('detach'), origin: z.enum(['platform', 'owner']).default('platform') }).strict(),
  z.object({ action: z.literal('add_to_plan'), origin: z.enum(['platform', 'owner']).default('platform') }).strict(),
]);
export const calendarReviewInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('verify'), note: z.string().trim().min(5).max(500), starts_on: isoDate.optional(), ends_on: isoDate.optional() }).strict(),
  z.object({ action: z.literal('withdraw'), note: z.string().trim().max(500).optional() }).strict(),
  z.object({ action: z.literal('restore') }).strict(),
]);
export const platformCalendarImportInput = z.object({ target: z.enum(['starter', 'sources']), source_id: z.string().regex(/^[a-z0-9_-]{2,40}$/).optional() }).strict();
export const radarCalendarQuery = z.object({ days: z.coerce.number().int().min(7).max(400).optional() }).strict();

type Ctx = { businessId: string; actor: AuditActor; locale: LoomLocale };

export const getRadar = (c: Pick<Ctx, 'businessId' | 'locale'>) => radarView(c.businessId, c.locale);
export const getCalendar = (c: Pick<Ctx, 'businessId' | 'locale'>, days?: number) => businessCalendar(c.businessId, c.locale, { days });

export async function createSource(c: Ctx, input: z.infer<typeof signalSourceInput>) {
  const r = await addSource(c, input);
  if (r.fetch.ok) await assessClusters(c.businessId);
  return r;
}
export const patchSource = (c: Ctx, id: string, p: z.infer<typeof signalSourcePatch>) => updateSource(c, id, p.status);
export async function fetchSourceNow(c: Ctx, id: string) {
  const r = await fetchSource(c.businessId, id);
  if (r.ok) await assessClusters(c.businessId);
  return r;
}

/** Cluster decisions other than add_to_plan (which needs the host ActionPort). */
export async function decideSignal(c: Ctx, id: string, input: Exclude<z.infer<typeof clusterDecisionInput>, { action: 'add_to_plan' }>) {
  if (input.action === 'attach') return attachTiming(c, { kind: 'signal_cluster', id }, input.opportunity_id);
  if (input.action === 'detach') return detachTiming(c, { kind: 'signal_cluster', id });
  return decideCluster(c, id, input.action);
}

export async function calendarAction(c: Ctx, id: string, input: Exclude<z.infer<typeof calendarActionInput>, { action: 'add_to_plan' }>) {
  if (input.action === 'adopt') return setCalendarChoice(c, id, 'adopted');
  if (input.action === 'hide') return setCalendarChoice(c, id, 'hidden');
  if (input.action === 'reset') return setCalendarChoice(c, id, null);
  const ref = { kind: input.origin === 'owner' ? 'owner_event' as const : 'platform_event' as const, id };
  return input.action === 'attach' ? attachTiming(c, ref, input.opportunity_id) : detachTiming(c, ref);
}

export const getMarket = (c: Pick<Ctx, 'businessId' | 'locale'>, archived = false) => listMarketObservations(c, { archived });
export const createMarketObservation = addMarketObservation;
export const patchMarketObservation = updateMarketObservation;
export const reviewCalendarEvent = (actor: AuditActor, id: string, input: ReviewInput) => reviewPlatformEvent(actor, id, input);
