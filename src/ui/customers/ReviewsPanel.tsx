'use client';

import { useState } from 'react';
import { EyeOff, Flag, MessageSquareReply, Star, Eye } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useI18n } from '@/i18n/client';
import { formatDate } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { useAccess } from '../shell/access-context';
import { Button } from '../components/button';
import { Alert, Badge, EmptyState, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input, Select, Textarea } from '../components/form';
import { Pager, Stat } from '../components/layout';
import { useCursorStack } from '../policy/paging';

type Review = {
  id: string; rating: number; comment: string | null; status: string; business_reply: string | null; moderation_reason: string | null;
  created_at: string; customer_name: string; booking_number: string; visit_at: string; staff_name: string | null;
};
type Data = { items: Review[]; next_cursor: string | null; stats: { published: number; average: number | null } };

export function ReviewsPanel() {
  const { t, locale } = useI18n();
  const access = useAccess();
  const [status, setStatus] = useState('all');
  const [rating, setRating] = useState('');
  const pager = useCursorStack(`${status}|${rating}`);
  const params = new URLSearchParams({ status, limit: '20' });
  if (rating) params.set('rating', rating);
  if (pager.cursor) params.set('cursor', pager.cursor);
  const q = useApiQuery<Data>(['reviews', access.slug, params.toString()], access.api(`/reviews?${params}`));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t('reviews.average')} value={q.data?.stats.average != null ? q.data.stats.average.toFixed(2) : '—'} />
        <Stat label={t('reviews.published')} value={q.data?.stats.published ?? '—'} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('fields.status')} className="min-w-36">{(p) => (
          <Select {...p} value={status} onChange={(e) => setStatus(e.target.value)}>{['all', 'published', 'hidden', 'flagged'].map((s) => <option key={s} value={s}>{t(`reviews.status.${s}`)}</option>)}</Select>
        )}</Field>
        <Field label={t('account.reviews.rating')} className="min-w-36">{(p) => (
          <Select {...p} value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">{t('reviews.any_rating')}</option>
            {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{t('reviews.rating', { n })}</option>)}
          </Select>
        )}</Field>
      </div>
      <p className="text-xs text-ink-muted">{t('reviews.never_deleted')}</p>
      {q.isLoading ? <LoadingState rows={4} /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.items.length ? <EmptyState title={t('reviews.empty')} icon={<Star className="size-8" aria-hidden />} /> : (
        <>
          <ul className="flex flex-col gap-3">{q.data.items.map((r) => <ReviewCard key={r.id} r={r} locale={locale} />)}</ul>
          <Pager hasPrev={pager.hasPrev} hasNext={!!q.data.next_cursor} onPrev={pager.prev} onNext={() => pager.next(q.data!.next_cursor!)} />
        </>
      )}
    </div>
  );
}

function ReviewCard({ r, locale }: { r: Review; locale: 'ar' | 'en' }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const qc = useQueryClient();
  const canManage = access.can('customers.manage') && !access.readOnly;
  const [reply, setReply] = useState(r.business_reply ?? '');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<null | 'reply' | 'moderate'>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function run(path: string, body: unknown) {
    setBusy(true); setErr(null);
    try {
      await api(access.api(path), { body });
      await qc.invalidateQueries({ queryKey: ['reviews', access.slug] });
      setMode(null); setReason('');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  }
  return (
    <li className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-0.5 font-semibold text-luma-700" aria-label={t('reviews.rating', { n: r.rating })}>
          {Array.from({ length: 5 }).map((_, i) => <Star key={i} className={`size-4 ${i < r.rating ? 'fill-current' : 'text-luma-200'}`} aria-hidden />)}
        </span>
        <span className="font-medium">{r.customer_name}</span>
        <span className="text-xs text-ink-muted">{t('reviews.visit')}: {formatDate(r.visit_at, { locale, tz: access.timezone })}{r.staff_name ? ` · ${r.staff_name}` : ''}</span>
        {r.status !== 'published' ? <Badge tone="warn">{t(`reviews.status.${r.status}`)}</Badge> : null}
      </div>
      {r.comment ? <p className="mt-2 text-sm">{r.comment}</p> : null}
      {r.moderation_reason && r.status !== 'published' ? <p className="mt-1 text-xs text-ink-muted">{t('fields.reason')}: {r.moderation_reason}</p> : null}
      {r.business_reply && mode !== 'reply' ? <div className="mt-2 rounded-lg bg-luma-50 p-2 text-sm"><p className="text-xs font-medium text-luma-800">{t('reviews.reply')}</p>{r.business_reply}</div> : null}
      <FormErrorSummary message={err ? msg(err) : null} />
      {canManage ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<MessageSquareReply className="size-4" />} onClick={() => setMode(mode === 'reply' ? null : 'reply')}>{t('reviews.reply')}</Button>
          <Button size="sm" variant="ghost" icon={r.status === 'published' ? <EyeOff className="size-4" /> : <Eye className="size-4" />} onClick={() => setMode(mode === 'moderate' ? null : 'moderate')}>{t('reviews.moderate')}</Button>
        </div>
      ) : null}
      {mode === 'reply' ? (
        <div className="mt-2 flex flex-col gap-2">
          <Field label={t('reviews.reply')}>{(p) => <Textarea {...p} maxLength={1000} placeholder={t('reviews.reply_placeholder')} value={reply} onChange={(e) => setReply(e.target.value)} />}</Field>
          <div className="flex gap-2">
            <Button size="sm" loading={busy} disabled={!reply.trim()} onClick={() => run(`/reviews/${r.id}/reply`, { reply: reply.trim() })}>{t('reviews.save_reply')}</Button>
            {r.business_reply ? <Button size="sm" variant="ghost" onClick={() => run(`/reviews/${r.id}/reply`, { reply: null })}>{t('reviews.remove_reply')}</Button> : null}
          </div>
        </div>
      ) : null}
      {mode === 'moderate' ? (
        <div className="mt-2 flex flex-col gap-2">
          <Alert tone="info">{t('reviews.never_deleted')}</Alert>
          <Field label={t('reviews.reason')} required>{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="flex flex-wrap gap-2">
            {r.status !== 'hidden' ? <Button size="sm" variant="outline" icon={<EyeOff className="size-4" />} loading={busy} disabled={reason.trim().length < 3} onClick={() => run(`/reviews/${r.id}/moderate`, { status: 'hidden', reason })}>{t('reviews.hide')}</Button> : null}
            {r.status !== 'flagged' ? <Button size="sm" variant="outline" icon={<Flag className="size-4" />} loading={busy} disabled={reason.trim().length < 3} onClick={() => run(`/reviews/${r.id}/moderate`, { status: 'flagged', reason })}>{t('reviews.flag')}</Button> : null}
            {r.status !== 'published' ? <Button size="sm" variant="outline" icon={<Eye className="size-4" />} loading={busy} disabled={reason.trim().length < 3} onClick={() => run(`/reviews/${r.id}/moderate`, { status: 'published', reason })}>{t('reviews.publish')}</Button> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}
