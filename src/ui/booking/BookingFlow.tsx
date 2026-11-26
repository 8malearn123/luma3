'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { CalendarDays, Check, Clock, Plus, Trash2, User } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api, ApiError, newIdempotencyKey } from '../api';
import { useErrorMessage } from '../hooks';
import { cx } from '../components/cx';
import { formatDuration, formatMoney, formatTime, tzLabel } from '@/shared/format';
import { badgeLabel, type ServiceBadge } from '@/shared/badges';

/** A customer-selectable variant or add-on (display data only; the server re-prices every quote). */
export type FlowOption = { id: string; name_ar: string | null; name_en: string | null; price_minor: number; duration_min: number };
export type FlowService = {
  id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; price_display: string; duration_min: number;
  category: { id: string; name_ar: string | null; name_en: string | null } | null;
  /** Set when the service is offered at one branch only. */
  branch_id?: string | null;
  badge?: ServiceBadge | null;
  variants?: FlowOption[];
  addons?: FlowOption[];
  staff: Array<{ id: string; name: string; name_en: string | null; title_ar: string | null; title_en: string | null; photo: string | null; branch_ids?: string[] }>;
};
export type FlowBranch = { id: string; name: string; city: string | null };
type CouponPreview = { code: string; subtotal_minor: number; discount_minor: number; total_minor: number; deposit_minor: number };
type Pick = { key: string; serviceId: string; staffId: string | null; variantId?: string | null; addonIds?: string[] };
/** Selection saved across a sign-in round trip (sessionStorage), re-validated against live availability and prices on return. */
type Draft = { picks: Pick[]; day: string; start: string; note: string; savedAt: number; branchId?: string | null; coupon?: string; totalMinor?: number; reason?: 'sign_in' | 'session_expired' };
type Option = { start: string; end: string; gaps_min: number[]; total_gap_min: number; items: Array<{ key: string; service_id: string; staff_id: string; staff_name: string; staff_name_en?: string | null; start: string; end: string; price_minor: number; duration_min: number }> };
type Search = { days: Record<string, Option[]>; next_available_date: string | null; empty_reason: string | null; suggestion: string | null; timezone: string };

const STORAGE_KEY = (slug: string) => `luma.booking.${slug}`;
let keySeq = 0;
const newKey = () => `i${Date.now().toString(36)}${(keySeq++).toString(36)}`;

/** Storefront-themed primitives (sf-* tokens come from the business's brand). */
const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';
const sfPrimary = `${sfBtn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const sfOutline = `${sfBtn} border border-sf-border text-sf-text hover:bg-sf-surface`;

/**
 * Services and specialists offered at one branch. With a single branch (no
 * picker) everything is shown; with several, a branch-only service or a
 * specialist not assigned to the branch is hidden.
 */
export function servicesAtBranch(services: FlowService[], branchId: string | null): FlowService[] {
  if (!branchId) return services;
  return services
    .filter((s) => !s.branch_id || s.branch_id === branchId)
    .map((s) => ({ ...s, staff: s.staff.filter((st) => !st.branch_ids || st.branch_ids.includes(branchId)) }))
    .filter((s) => s.staff.length > 0);
}

export function BookingFlow({ slug, tenantName, timezone, services: allServices, signedIn, verified, policy, initial, branches = [], rebooking = false }: {
  slug: string; tenantName: string; timezone: string; services: FlowService[]; signedIn: boolean; verified: boolean;
  policy: { holdMin: number; freeHours: number; lateFeeBp: number };
  initial: { serviceId: string | null; staffId: string | null; picks?: Array<{ serviceId: string; staffId: string | null }> | null; branchId?: string | null };
  branches?: FlowBranch[]; rebooking?: boolean;
}) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const [branchId, setBranchId] = useState<string | null>(branches.length ? (initial.branchId ?? branches[0]!.id) : null);
  const services = useMemo(() => servicesAtBranch(allServices, branchId), [allServices, branchId]);
  const [couponCode, setCouponCode] = useState('');
  const [coupon, setCoupon] = useState<CouponPreview | null>(null);
  const [couponErr, setCouponErr] = useState<unknown>(null);
  const [couponBusy, setCouponBusy] = useState(false);
  const [picks, setPicks] = useState<Pick[]>(() => {
    if (initial.picks?.length) {
      // Rebook: same services and the same specialists (when still offered); she chooses the new time.
      return initial.picks.filter((p) => services.some((s) => s.id === p.serviceId)).slice(0, 6)
        .map((p) => ({ key: newKey(), serviceId: p.serviceId, staffId: p.staffId && services.find((s) => s.id === p.serviceId)!.staff.some((st) => st.id === p.staffId) ? p.staffId : null }));
    }
    const s = services.find((x) => x.id === initial.serviceId) ?? (initial.staffId ? services.find((x) => x.staff.some((st) => st.id === initial.staffId)) : undefined);
    return s ? [{ key: newKey(), serviceId: s.id, staffId: initial.staffId && s.staff.some((st) => st.id === initial.staffId) ? initial.staffId : null }] : [];
  });
  const today = DateTime.now().setZone(timezone).startOf('day');
  const [windowStart, setWindowStart] = useState(today);
  const [day, setDay] = useState<string | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [chosen, setChosen] = useState<Option | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitlisted, setWaitlisted] = useState(false);
  const [consent, setConsent] = useState(true);
  const [idemKey] = useState(newIdempotencyKey);
  const [resumeNote, setResumeNote] = useState<string | null>(null);

  // Restore a selection saved before signing in, then re-validate it against live availability.
  const [resumeStart, setResumeStart] = useState<string | null>(null);
  const [resumeDraft, setResumeDraft] = useState<Draft | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY(slug));
      if (!raw) return;
      const saved = JSON.parse(raw) as Draft;
      if (Date.now() - saved.savedAt > 30 * 60_000) { sessionStorage.removeItem(STORAGE_KEY(slug)); return; }
      const savedBranch = saved.branchId && branches.some((b) => b.id === saved.branchId) ? saved.branchId : branchId;
      // Restoring from sessionStorage must happen after hydration, so it lives in an effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBranchId(savedBranch);
      if (saved.coupon) setCouponCode(saved.coupon);
      const offered = servicesAtBranch(allServices, savedBranch);
      setPicks(saved.picks.filter((p) => offered.some((s) => s.id === p.serviceId)).map((p) => sanitizePick(p, offered.find((s) => s.id === p.serviceId)!)));
      setDay(saved.day); setNote(saved.note); setResumeStart(saved.start); setResumeDraft(saved);
      setWindowStart(DateTime.fromISO(saved.day, { zone: timezone }));
    } catch { /* storage unavailable: start fresh */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, timezone]);

  const key = JSON.stringify([branchId, picks.map((p) => [p.serviceId, p.staffId, p.variantId ?? null, p.addonIds ?? []])]);
  useEffect(() => {
    // Resetting request state when the inputs change; the fetch itself resolves asynchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!picks.length) { setSearch(null); return; }
    const ctrl = new AbortController();
    setLoading(true); setError(null); setChosen(null);
    api<Search>(`/api/v1/s/${slug}/availability`, {
      body: { ...(branchId ? { branch_id: branchId } : {}), items: picks.map((p) => ({ ...itemOptions(p), key: p.key, service_id: p.serviceId, staff_id: p.staffId })), from: windowStart.toISODate(), to: windowStart.plus({ days: 6 }).toISODate() },
      signal: ctrl.signal,
    }).then((r) => {
      setSearch(r);
      const firstDay = Object.entries(r.days).find(([, opts]) => opts.length)?.[0] ?? null;
      setDay((d) => (d && r.days[d] ? d : firstDay));
    }).catch((e) => { if ((e as Error).name !== 'AbortError') setError(e); }).finally(() => setLoading(false));
    return () => ctrl.abort();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, windowStart, slug]);

  useEffect(() => {
    if (!resumeStart || !search || !day) return;
    const o = search.days[day]?.find((x) => x.start === resumeStart);
    // One-shot reconciliation of a restored selection once live availability arrives:
    // the time must still be free and the price is re-quoted by the server.
    if (o) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChosen(o);
      const now = o.items.reduce((a, i) => a + i.price_minor, 0);
      const before = resumeDraft?.totalMinor;
      if (before != null && before !== now) setResumeNote(t('booking.flow.resume_price_changed', { from: formatMoney(before, 'SAR', locale), to: formatMoney(now, 'SAR', locale) }));
      else setResumeNote(t(resumeDraft?.reason === 'session_expired' ? 'booking.flow.resume_after_expiry' : 'booking.flow.resume_ok'));
    } else {
      setError(new ApiError(409, 'slot_unavailable', 'slot'));
      setResumeNote(null);
    }
    setResumeStart(null); setResumeDraft(null);
    try { sessionStorage.removeItem(STORAGE_KEY(slug)); } catch { /* ignore */ }
  }, [resumeStart, search, day, slug, resumeDraft, t, locale]);

  const grouped = useMemo(() => {
    const m = new Map<string, { label: string; items: FlowService[] }>();
    for (const s of services) {
      const k = s.category?.id ?? '_';
      if (!m.has(k)) m.set(k, { label: s.category ? pick(s.category.name_ar, s.category.name_en) : '', items: [] });
      m.get(k)!.items.push(s);
    }
    return [...m.values()];
  }, [services, pick]);

  const svc = (id: string) => services.find((s) => s.id === id)!;
  const fmtT = (iso: string) => formatTime(iso, { tz: timezone, locale, timeFormat });
  const options = (day && search?.days[day]) || [];

  /** Saves the selection and goes through the existing sign-in-and-return path. */
  function signInAndReturn(reason: Draft['reason']) {
    if (!chosen) return;
    const draft: Draft = { picks, day: day!, start: chosen.start, note, savedAt: Date.now(), branchId, coupon: coupon?.code ?? couponCode, totalMinor: chosen.items.reduce((a, i) => a + i.price_minor, 0), reason };
    try { sessionStorage.setItem(STORAGE_KEY(slug), JSON.stringify(draft)); } catch { /* ignore */ }
    window.location.href = `/auth/login?next=${encodeURIComponent(`/s/${slug}/booking`)}`;
  }

  async function reserve() {
    if (!chosen) return;
    if (!signedIn || !verified) { signInAndReturn('sign_in'); return; }
    setBusy(true); setError(null);
    try {
      const r = await api<{ booking_id: string }>(`/api/v1/s/${slug}/bookings`, {
        body: {
          ...(branchId ? { branch_id: branchId } : {}),
          items: chosen.items.map((i) => ({ ...itemOptions(picks.find((p) => p.key === i.key)), key: i.key, service_id: i.service_id, staff_id: i.staff_id, start: i.start })), customer_note: note || undefined,
          ...(coupon ? { coupon_code: coupon.code } : {}),
        },
        idempotencyKey: idemKey,
      });
      window.location.href = `/s/${slug}/checkout/booking/${r.booking_id}`;
    } catch (e) {
      // The session ended mid-booking: keep the selection and sign in again (it is re-validated on return).
      if (e instanceof ApiError && e.status === 401) { signInAndReturn('session_expired'); return; }
      setError(e);
      if (e instanceof ApiError && e.code === 'slot_unavailable') { setChosen(null); setWindowStart((w) => w.plus({ milliseconds: 1 }).minus({ milliseconds: 1 })); }
      if (e instanceof ApiError && e.code.startsWith('coupon_')) setCoupon(null);
    } finally { setBusy(false); }
  }

  async function applyCoupon() {
    if (!chosen || couponCode.trim().length < 3) return;
    setCouponBusy(true); setCouponErr(null);
    try {
      setCoupon(await api<CouponPreview>(`/api/v1/s/${slug}/bookings/coupon`, {
        body: { ...(branchId ? { branch_id: branchId } : {}), code: couponCode.trim(), items: chosen.items.map((i) => ({ ...itemOptions(picks.find((p) => p.key === i.key)), key: i.key, service_id: i.service_id, staff_id: i.staff_id })) },
      }));
    } catch (e) { setCoupon(null); setCouponErr(e); } finally { setCouponBusy(false); }
  }

  function changeBranch(id: string) {
    setBranchId(id);
    const offered = servicesAtBranch(allServices, id);
    setPicks((ps) => ps.filter((p) => offered.some((s) => s.id === p.serviceId))
      .map((p) => ({ ...p, staffId: p.staffId && offered.find((s) => s.id === p.serviceId)!.staff.some((st) => st.id === p.staffId) ? p.staffId : null })));
    setChosen(null); setCoupon(null);
  }

  async function joinWaitlist() {
    const p = picks[0];
    if (!p) return;
    if (!signedIn) { window.location.href = `/auth/login?next=${encodeURIComponent(`/s/${slug}/booking?service=${p.serviceId}`)}`; return; }
    setBusy(true); setError(null);
    try {
      await api(`/api/v1/s/${slug}/waitlist`, { body: { service_id: p.serviceId, staff_id: p.staffId, desired_from: windowStart.toISODate(), desired_to: windowStart.plus({ days: 6 }).toISODate(), notify_consent: consent } });
      setWaitlisted(true);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const total = chosen ? chosen.items.reduce((a, i) => a + i.price_minor, 0) : picks.reduce((a, p) => a + estimate(svc(p.serviceId), p).price, 0);
  const setPick = (k: string, patch: Partial<Pick>) => setPicks(picks.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const days = Array.from({ length: 7 }, (_, i) => windowStart.plus({ days: i }));

  return (
    <div className="storefront mx-auto max-w-3xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t('booking.flow.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{tenantName} · {t('time.tz_note', { tz: tzLabel(timezone, locale) })}</p>
      {error ? <div role="alert" className="mb-4 rounded-[var(--radius-sf)] border border-danger/30 bg-danger-bg p-3 text-sm text-danger">{msg(error)}</div> : null}
      {resumeNote ? <p role="status" className="mb-4 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-3 text-sm">{resumeNote}</p> : null}
      {rebooking ? <p role="status" className="mb-4 rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-3 text-sm">{t('customer.rebook.flow_note')}</p> : null}

      {branches.length > 1 ? (
        <section aria-labelledby="branch-h" className="mb-6">
          <h2 id="branch-h" className="mb-2 font-sf-heading text-lg">{t('customer.branch.choose')}</h2>
          <div role="radiogroup" aria-labelledby="branch-h" className="grid gap-2 sm:grid-cols-2">
            {branches.map((b) => (
              <label key={b.id} className={cx('flex cursor-pointer items-start gap-2 rounded-[var(--radius-sf)] border p-3 text-sm', branchId === b.id ? 'border-sf-primary bg-sf-surface' : 'border-sf-border')}>
                <input type="radio" name="branch" className="mt-1" checked={branchId === b.id} onChange={() => changeBranch(b.id)} />
                <span><span className="block font-medium">{b.name}</span>{b.city ? <span className="text-xs text-sf-muted">{b.city}</span> : null}</span>
              </label>
            ))}
          </div>
        </section>
      ) : null}

      {/* 1. Services */}
      <section aria-labelledby="svc-h" className="mb-6">
        <h2 id="svc-h" className="mb-2 font-sf-heading text-lg">1. {t('booking.flow.choose_service')}</h2>
        {picks.length ? (
          <ol className="mb-3 flex flex-col gap-2">
            {picks.map((p, idx) => {
              const s = svc(p.serviceId);
              return (
                <li key={p.key} className="rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="flex flex-wrap items-center gap-2 font-medium">{pick(s.name_ar, s.name_en)}{s.badge ? <FlowBadge b={s.badge} locale={locale} /> : null}</p>
                      <p className="text-xs text-sf-muted">{formatDuration(estimate(s, p).duration, locale)} · {s.price_display === 'starting_from' && !p.variantId ? '≥ ' : ''}{formatMoney(estimate(s, p).price, 'SAR', locale)}</p>
                    </div>
                    <button className="text-sf-muted hover:text-sf-text" aria-label={t('booking.flow.remove_service')} onClick={() => setPicks(picks.filter((x) => x.key !== p.key))}><Trash2 className="size-4" /></button>
                  </div>
                  <label className="mt-2 block text-xs text-sf-muted" htmlFor={`st-${p.key}`}>{picks.length > 1 ? t('booking.flow.staff_for', { n: idx + 1, service: pick(s.name_ar, s.name_en) }) : t('booking.flow.choose_staff')}</label>
                  <select id={`st-${p.key}`} value={p.staffId ?? ''} onChange={(e) => setPicks(picks.map((x) => (x.key === p.key ? { ...x, staffId: e.target.value || null } : x)))}
                    className="mt-1 h-10 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 text-sm">
                    <option value="">{t('booking.flow.any_staff')}</option>
                    {s.staff.map((st) => <option key={st.id} value={st.id}>{pick(st.name, st.name_en)}{st.title_ar || st.title_en ? ` — ${pick(st.title_ar, st.title_en)}` : ''}</option>)}
                  </select>
                  {!p.staffId ? <p className="mt-1 text-[11px] text-sf-muted">{t('booking.flow.any_staff_note')}</p> : null}
                  {s.variants?.length ? (
                    <>
                      <label className="mt-2 block text-xs text-sf-muted" htmlFor={`var-${p.key}`}>{t('booking.flow.choose_variant')}</label>
                      <select id={`var-${p.key}`} value={p.variantId ?? ''} onChange={(e) => setPick(p.key, { variantId: e.target.value || null })}
                        className="mt-1 h-10 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 text-sm">
                        <option value="">{t('booking.flow.standard_variant')} — {formatDuration(s.duration_min, locale)} · {formatMoney(s.price_minor, 'SAR', locale)}</option>
                        {s.variants.map((v) => <option key={v.id} value={v.id}>{pick(v.name_ar, v.name_en)} — {formatDuration(v.duration_min, locale)} · {formatMoney(v.price_minor, 'SAR', locale)}</option>)}
                      </select>
                    </>
                  ) : null}
                  {s.addons?.length ? (
                    <fieldset className="mt-2">
                      <legend className="text-xs text-sf-muted">{t('booking.flow.choose_addons')}</legend>
                      <div className="mt-1 flex flex-col gap-1">
                        {s.addons.map((a) => {
                          const on = (p.addonIds ?? []).includes(a.id);
                          return (
                            <label key={a.id} className="flex items-center justify-between gap-2 rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 py-1.5 text-sm">
                              <span className="inline-flex items-center gap-2"><input type="checkbox" checked={on} onChange={() => setPick(p.key, { addonIds: on ? (p.addonIds ?? []).filter((x) => x !== a.id) : [...(p.addonIds ?? []), a.id] })} />{pick(a.name_ar, a.name_en)}</span>
                              <span className="text-xs text-sf-muted">+{formatMoney(a.price_minor, 'SAR', locale)}{a.duration_min ? ` · +${formatDuration(a.duration_min, locale)}` : ''}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
        <details className="rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface" open={!picks.length}>
          <summary className="flex cursor-pointer items-center gap-2 p-3 text-sm font-medium"><Plus className="size-4" />{picks.length ? t('booking.flow.add_service') : t('booking.flow.choose_service')}</summary>
          <div className="flex flex-col gap-4 p-3 pt-0">
            {grouped.map((g) => (
              <div key={g.label || '_'}>
                {g.label ? <p className="mb-1 text-xs font-semibold text-sf-muted">{g.label}</p> : null}
                <ul className="flex flex-col gap-1">
                  {g.items.map((s) => (
                    <li key={s.id}>
                      <button disabled={picks.length >= 6} onClick={() => setPicks([...picks, { key: newKey(), serviceId: s.id, staffId: null }])}
                        className="flex w-full items-center justify-between gap-2 rounded-[var(--radius-sf)] px-2 py-2 text-start hover:bg-sf-bg">
                        <span><span className="flex flex-wrap items-center gap-2 text-sm">{pick(s.name_ar, s.name_en)}{s.badge ? <FlowBadge b={s.badge} locale={locale} /> : null}</span><span className="text-xs text-sf-muted">{formatDuration(s.duration_min, locale)}</span></span>
                        <span className="text-sm">{formatMoney(s.price_minor, 'SAR', locale)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!services.length ? <p className="text-sm text-sf-muted">{t('booking.flow.service_unavailable')}</p> : null}
          </div>
        </details>
      </section>

      {/* 2. Time */}
      {picks.length ? (
        <section aria-labelledby="time-h" className="mb-6">
          <h2 id="time-h" className="mb-2 font-sf-heading text-lg">2. {t('booking.flow.choose_time')}</h2>
          <div className="mb-3 flex items-center gap-1 overflow-x-auto pb-1" role="tablist" aria-label={t('fields.date')}>
            <button className={sfOutline} disabled={windowStart <= today} onClick={() => setWindowStart(windowStart.minus({ days: 7 }) < today ? today : windowStart.minus({ days: 7 }))} aria-label={t('actions.previous')}>‹</button>
            {days.map((d) => {
              const iso = d.toISODate()!;
              const n = search?.days[iso]?.length ?? 0;
              return (
                <button key={iso} role="tab" aria-selected={day === iso} disabled={!n && !loading} onClick={() => { setDay(iso); setChosen(null); }}
                  className={cx('flex min-w-14 flex-col items-center rounded-[var(--radius-sf)] border px-2 py-1.5 text-xs disabled:opacity-40', day === iso ? 'border-sf-primary bg-sf-primary text-sf-on-primary' : 'border-sf-border bg-sf-surface')}>
                  <span>{d.setLocale(locale).toFormat('ccc')}</span><span className="text-base font-semibold">{d.toFormat('d')}</span>
                </button>
              );
            })}
            <button className={sfOutline} onClick={() => setWindowStart(windowStart.plus({ days: 7 }))} aria-label={t('actions.next')}>›</button>
          </div>
          {loading ? <p role="status" className="text-sm text-sf-muted">{t('booking.flow.loading_times')}</p> : options.length ? (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {options.map((o) => (
                <button key={o.start} onClick={() => { setChosen(o); setCoupon(null); }} aria-pressed={chosen?.start === o.start}
                  className={cx('rounded-[var(--radius-sf)] border px-2 py-2 text-sm', chosen?.start === o.start ? 'border-sf-primary bg-sf-primary text-sf-on-primary' : 'border-sf-border bg-sf-surface hover:border-sf-primary')}>
                  {fmtT(o.start)}
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-[var(--radius-sf)] border border-dashed border-sf-border p-4 text-sm">
              <p>{t('booking.flow.no_times')}</p>
              {search?.next_available_date ? (
                <button className="mt-2 underline" onClick={() => setWindowStart(DateTime.fromISO(search.next_available_date!, { zone: timezone }))}>
                  {t('booking.flow.next_available', { date: DateTime.fromISO(search.next_available_date, { zone: timezone }).setLocale(locale).toFormat('cccc d LLLL') })}
                </button>
              ) : null}
              {search?.suggestion ? <p className="mt-1 text-sf-muted">{t('booking.flow.try_separate')}</p> : null}
              {waitlisted ? <p className="mt-3 text-sf-primary">{t('booking.flow.waitlist_joined')}</p> : picks.length === 1 ? (
                <div className="mt-3 flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{t('booking.flow.waitlist_consent')}</label>
                  <button className={sfOutline + ' self-start'} disabled={busy} onClick={joinWaitlist}>{t('booking.flow.waitlist_cta')}</button>
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* 3. Review */}
      {chosen ? (
        <section aria-labelledby="rev-h" className="rounded-[var(--radius-sf)] border border-sf-border bg-sf-surface p-4">
          <h2 id="rev-h" className="mb-3 font-sf-heading text-lg">3. {t('booking.flow.summary')}</h2>
          <ol className="flex flex-col gap-2">
            {chosen.items.map((i, idx) => (
              <li key={i.key} className="text-sm">
                {idx > 0 && chosen.gaps_min[idx - 1] ? <p className="mb-1 text-xs text-sf-muted">{t('booking.flow.gap', { n: chosen.gaps_min[idx - 1]! })}</p> : null}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{pick(svc(i.service_id).name_ar, svc(i.service_id).name_en)}</p>
                    {optionLabel(svc(i.service_id), picks.find((p) => p.key === i.key), pick) ? <p className="text-xs text-sf-muted">{optionLabel(svc(i.service_id), picks.find((p) => p.key === i.key), pick)}</p> : null}
                    <p className="flex flex-wrap items-center gap-x-3 text-xs text-sf-muted">
                      <span className="inline-flex items-center gap-1"><Clock className="size-3" />{fmtT(i.start)}–{fmtT(i.end)}</span>
                      <span className="inline-flex items-center gap-1"><User className="size-3" />{t('booking.flow.with', { name: pick(i.staff_name, i.staff_name_en) })}</span>
                    </p>
                  </div>
                  <span>{formatMoney(i.price_minor, 'SAR', locale)}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-between border-t border-sf-border pt-3 text-sm">
            <span className="inline-flex items-center gap-1"><CalendarDays className="size-4" />{DateTime.fromISO(chosen.start, { zone: timezone }).setLocale(locale).toFormat('cccc d LLLL')} · {t('booking.flow.duration')}: {formatDuration(Math.round((Date.parse(chosen.end) - Date.parse(chosen.start)) / 60000), locale)}</span>
            <span className="font-semibold">{t('booking.flow.total')}: {coupon ? <><s className="me-1 font-normal text-sf-muted">{formatMoney(total, 'SAR', locale)}</s>{formatMoney(coupon.total_minor, 'SAR', locale)}</> : formatMoney(total, 'SAR', locale)}</span>
          </div>
          <div className="mt-3">
            <label htmlFor="bk-coupon" className="block text-sm">{t('customer.coupon.label')}</label>
            <div className="mt-1 flex gap-2">
              <input id="bk-coupon" dir="ltr" maxLength={40} value={couponCode} onChange={(e) => { setCouponCode(e.target.value.replace(/[^A-Za-z0-9_-]/g, '')); setCoupon(null); setCouponErr(null); }}
                className="h-10 min-w-0 flex-1 rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 font-mono text-sm uppercase" placeholder={t('customer.coupon.placeholder')} aria-describedby="bk-coupon-status" />
              {coupon
                ? <button type="button" className={sfOutline} onClick={() => { setCoupon(null); setCouponCode(''); }}>{t('customer.coupon.remove')}</button>
                : <button type="button" className={sfOutline} disabled={couponBusy || couponCode.trim().length < 3} onClick={applyCoupon}>{t('customer.coupon.apply')}</button>}
            </div>
            <p id="bk-coupon-status" role="status" className="mt-1 text-xs">
              {coupon ? <span className="text-sf-primary">{t('customer.coupon.applied', { amount: formatMoney(coupon.discount_minor, 'SAR', locale) })}{coupon.deposit_minor ? ` · ${t('customer.coupon.deposit_after', { amount: formatMoney(coupon.deposit_minor, 'SAR', locale) })}` : ''}</span>
                : couponErr ? <span className="text-red-700">{msg(couponErr)}</span> : null}
            </p>
          </div>
          <p className="mt-1 text-[11px] text-sf-muted">{t('booking.flow.prices_note')}</p>
          <div className="mt-3 text-xs text-sf-muted">
            <p>{t('booking.checkout.policy_free', { h: policy.freeHours })}{policy.lateFeeBp ? ` ${t('booking.checkout.policy_fee', { p: policy.lateFeeBp / 100 })}` : ''}</p>
            <Link className="underline" href={`/s/${slug}/policies`}>{t('booking.checkout.policy')}</Link>
          </div>
          <label htmlFor="bk-note" className="mt-3 block text-sm">{t('booking.flow.notes')}</label>
          <textarea id="bk-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg p-2 text-sm" rows={2} />
          {!signedIn ? <p className="mt-3 text-xs text-sf-muted">{t('booking.flow.sign_in_note')}</p> : null}
          <button className={sfPrimary + ' mt-4 w-full'} disabled={busy} onClick={reserve} aria-busy={busy}>
            {signedIn && verified ? <><Check className="size-4" />{t('booking.flow.reserve')}</> : t('booking.flow.sign_in')}
          </button>
          <p className="mt-2 text-center text-[11px] text-sf-muted">{t('booking.flow.hold_note', { min: policy.holdMin })}</p>
        </section>
      ) : null}
    </div>
  );
}

/** The options a pick sends with every quote/hold (the server validates and prices them). */
function itemOptions(p: Pick | undefined) {
  if (!p) return {};
  return { ...(p.variantId ? { variant_id: p.variantId } : {}), ...(p.addonIds?.length ? { addon_ids: p.addonIds } : {}) };
}

/** Drops options that are no longer offered (e.g. a restored draft after the business changed its menu). */
function sanitizePick(p: Pick, s: FlowService): Pick {
  return { ...p, variantId: p.variantId && s.variants?.some((v) => v.id === p.variantId) ? p.variantId : null, addonIds: (p.addonIds ?? []).filter((id) => s.addons?.some((a) => a.id === id)) };
}

/** Display estimate before a time is chosen; the summary always shows the server's quote. */
function estimate(s: FlowService, p: Pick) {
  const v = p.variantId ? s.variants?.find((x) => x.id === p.variantId) : undefined;
  const adds = (s.addons ?? []).filter((a) => (p.addonIds ?? []).includes(a.id));
  return { price: (v?.price_minor ?? s.price_minor) + adds.reduce((a, x) => a + x.price_minor, 0), duration: (v?.duration_min ?? s.duration_min) + adds.reduce((a, x) => a + x.duration_min, 0) };
}

function optionLabel(s: FlowService, p: Pick | undefined, pick: (ar: string | null, en: string | null) => string) {
  if (!p) return '';
  const v = p.variantId ? s.variants?.find((x) => x.id === p.variantId) : undefined;
  const adds = (s.addons ?? []).filter((a) => (p.addonIds ?? []).includes(a.id));
  return [v ? pick(v.name_ar, v.name_en) : null, ...adds.map((a) => `+ ${pick(a.name_ar, a.name_en)}`)].filter(Boolean).join(' · ');
}

function FlowBadge({ b, locale }: { b: ServiceBadge; locale: 'ar' | 'en' }) {
  const text = badgeLabel(b, locale);
  return text ? <span data-badge={b.kind} className="rounded-full bg-sf-primary px-2 py-0.5 text-[10px] font-semibold text-sf-on-primary">{text}</span> : null;
}
