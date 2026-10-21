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

export type FlowService = {
  id: string; name_ar: string | null; name_en: string | null; description_ar: string | null; description_en: string | null; price_minor: number; price_display: string; duration_min: number;
  category: { id: string; name_ar: string | null; name_en: string | null } | null;
  staff: Array<{ id: string; name: string; name_en: string | null; title_ar: string | null; title_en: string | null; photo: string | null }>;
};
type Pick = { key: string; serviceId: string; staffId: string | null };
type Option = { start: string; end: string; gaps_min: number[]; total_gap_min: number; items: Array<{ key: string; service_id: string; staff_id: string; staff_name: string; start: string; end: string; price_minor: number; duration_min: number }> };
type Search = { days: Record<string, Option[]>; next_available_date: string | null; empty_reason: string | null; suggestion: string | null; timezone: string };

const STORAGE_KEY = (slug: string) => `luma.booking.${slug}`;
let keySeq = 0;
const newKey = () => `i${Date.now().toString(36)}${(keySeq++).toString(36)}`;

/** Storefront-themed primitives (sf-* tokens come from the business's brand). */
const sfBtn = 'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sf)] px-4 py-2.5 text-sm font-medium transition disabled:opacity-50';
const sfPrimary = `${sfBtn} bg-sf-primary text-sf-on-primary hover:opacity-90`;
const sfOutline = `${sfBtn} border border-sf-border text-sf-text hover:bg-sf-surface`;

export function BookingFlow({ slug, tenantName, timezone, services, signedIn, verified, policy, initial }: {
  slug: string; tenantName: string; timezone: string; services: FlowService[]; signedIn: boolean; verified: boolean;
  policy: { holdMin: number; freeHours: number; lateFeeBp: number }; initial: { serviceId: string | null; staffId: string | null };
}) {
  const { t, locale, pick, timeFormat } = useI18n();
  const msg = useErrorMessage();
  const [picks, setPicks] = useState<Pick[]>(() => {
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

  // Restore a selection saved before signing in, then re-validate it against live availability.
  const [resumeStart, setResumeStart] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY(slug));
      if (!raw) return;
      const saved = JSON.parse(raw) as { picks: Pick[]; day: string; start: string; note: string; savedAt: number };
      if (Date.now() - saved.savedAt > 30 * 60_000) { sessionStorage.removeItem(STORAGE_KEY(slug)); return; }
      setPicks(saved.picks.filter((p) => services.some((s) => s.id === p.serviceId)));
      setDay(saved.day); setNote(saved.note); setResumeStart(saved.start);
      setWindowStart(DateTime.fromISO(saved.day, { zone: timezone }));
    } catch { /* storage unavailable: start fresh */ }
  }, [slug, services, timezone]);

  const key = JSON.stringify(picks.map((p) => [p.serviceId, p.staffId]));
  useEffect(() => {
    if (!picks.length) { setSearch(null); return; }
    const ctrl = new AbortController();
    setLoading(true); setError(null); setChosen(null);
    api<Search>(`/api/v1/s/${slug}/availability`, {
      body: { items: picks.map((p) => ({ key: p.key, service_id: p.serviceId, staff_id: p.staffId })), from: windowStart.toISODate(), to: windowStart.plus({ days: 6 }).toISODate() },
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
    if (o) setChosen(o); else setError(new ApiError(409, 'slot_unavailable', 'slot'));
    setResumeStart(null);
    try { sessionStorage.removeItem(STORAGE_KEY(slug)); } catch { /* ignore */ }
  }, [resumeStart, search, day, slug]);

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

  async function reserve() {
    if (!chosen) return;
    if (!signedIn || !verified) {
      try { sessionStorage.setItem(STORAGE_KEY(slug), JSON.stringify({ picks, day, start: chosen.start, note, savedAt: Date.now() })); } catch { /* ignore */ }
      window.location.href = `/auth/login?next=${encodeURIComponent(`/s/${slug}/booking`)}`;
      return;
    }
    setBusy(true); setError(null);
    try {
      const r = await api<{ booking_id: string }>(`/api/v1/s/${slug}/bookings`, {
        body: { items: chosen.items.map((i) => ({ key: i.key, service_id: i.service_id, staff_id: i.staff_id, start: i.start })), customer_note: note || undefined },
        idempotencyKey: idemKey,
      });
      window.location.href = `/s/${slug}/checkout/booking/${r.booking_id}`;
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.code === 'slot_unavailable') { setChosen(null); setWindowStart((w) => w.plus({ milliseconds: 1 }).minus({ milliseconds: 1 })); }
    } finally { setBusy(false); }
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

  const total = chosen ? chosen.items.reduce((a, i) => a + i.price_minor, 0) : picks.reduce((a, p) => a + svc(p.serviceId).price_minor, 0);
  const days = Array.from({ length: 7 }, (_, i) => windowStart.plus({ days: i }));

  return (
    <div className="storefront mx-auto max-w-3xl px-4 py-6 text-sf-text">
      <h1 className="font-sf-heading text-2xl">{t('booking.flow.title')}</h1>
      <p className="mb-4 text-sm text-sf-muted">{tenantName} · {t('time.tz_note', { tz: tzLabel(timezone, locale) })}</p>
      {error ? <div role="alert" className="mb-4 rounded-[var(--radius-sf)] border border-red-200 bg-red-50 p-3 text-sm text-red-800">{msg(error)}</div> : null}

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
                      <p className="font-medium">{pick(s.name_ar, s.name_en)}</p>
                      <p className="text-xs text-sf-muted">{formatDuration(s.duration_min, locale)} · {s.price_display === 'starting_from' ? '≥ ' : ''}{formatMoney(s.price_minor, 'SAR', locale)}</p>
                    </div>
                    <button className="text-sf-muted hover:text-sf-text" aria-label={t('booking.flow.remove_service')} onClick={() => setPicks(picks.filter((x) => x.key !== p.key))}><Trash2 className="size-4" /></button>
                  </div>
                  <label className="mt-2 block text-xs text-sf-muted" htmlFor={`st-${p.key}`}>{idx + 1}. {t('booking.flow.choose_staff')}</label>
                  <select id={`st-${p.key}`} value={p.staffId ?? ''} onChange={(e) => setPicks(picks.map((x) => (x.key === p.key ? { ...x, staffId: e.target.value || null } : x)))}
                    className="mt-1 h-10 w-full rounded-[var(--radius-sf)] border border-sf-border bg-sf-bg px-2 text-sm">
                    <option value="">{t('booking.flow.any_staff')}</option>
                    {s.staff.map((st) => <option key={st.id} value={st.id}>{pick(st.name, st.name_en)}{st.title_ar || st.title_en ? ` — ${pick(st.title_ar, st.title_en)}` : ''}</option>)}
                  </select>
                  {!p.staffId ? <p className="mt-1 text-[11px] text-sf-muted">{t('booking.flow.any_staff_note')}</p> : null}
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
                        <span><span className="block text-sm">{pick(s.name_ar, s.name_en)}</span><span className="text-xs text-sf-muted">{formatDuration(s.duration_min, locale)}</span></span>
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
                <button key={o.start} onClick={() => setChosen(o)} aria-pressed={chosen?.start === o.start}
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
                    <p className="flex flex-wrap items-center gap-x-3 text-xs text-sf-muted">
                      <span className="inline-flex items-center gap-1"><Clock className="size-3" />{fmtT(i.start)}–{fmtT(i.end)}</span>
                      <span className="inline-flex items-center gap-1"><User className="size-3" />{t('booking.flow.with', { name: i.staff_name })}</span>
                    </p>
                  </div>
                  <span>{formatMoney(i.price_minor, 'SAR', locale)}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-between border-t border-sf-border pt-3 text-sm">
            <span className="inline-flex items-center gap-1"><CalendarDays className="size-4" />{DateTime.fromISO(chosen.start, { zone: timezone }).setLocale(locale).toFormat('cccc d LLLL')} · {t('booking.flow.duration')}: {formatDuration(Math.round((Date.parse(chosen.end) - Date.parse(chosen.start)) / 60000), locale)}</span>
            <span className="font-semibold">{t('booking.flow.total')}: {formatMoney(total, 'SAR', locale)}</span>
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
