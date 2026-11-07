'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Eye, EyeOff, FileText, Send, Store, Upload } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { formatDateTime } from '@/shared/format';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge, ErrorState, LoadingState } from '../components/feedback';
import { Field, FormErrorSummary, Input } from '../components/form';
import { Card } from '../components/layout';
import { useToast } from '../components/toast';

type Status = {
  listing: { status: string; hidden: boolean; tagline_ar: string | null; tagline_en: string | null; cover_url: string | null; cover_asset_id: string | null; requested_at: string | null; reviewed_at: string | null; rejection_reason: string | null; commission_bp: number; commission_is_default: boolean };
  visible: boolean; blockers: string[];
  verification: { status: string; submitted_at: string | null; verified_at: string | null; rejection_reason: string | null; required: string[]; missing: string[];
    documents: Array<{ id: string; kind: string; mime: string; bytes: number; file_name: string | null; iban_masked: string | null; created_at: string }> };
  settings: { require_verification: boolean };
};

const tone = (s: string) => (s === 'approved' || s === 'verified' ? 'ok' : s === 'pending' ? 'info' : s === 'rejected' ? 'danger' : 'neutral') as 'ok' | 'info' | 'danger' | 'neutral';

/** Settings → سوق لوما: join request, visibility, card text/cover, and verification documents. */
export function MarketplaceSection({ slug, canManage }: { slug: string; canManage: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const msg = useErrorMessage();
  const key = ['tenant', slug, 'marketplace'];
  const q = useApiQuery<Status>(key, `/api/v1/t/${slug}/marketplace`);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tag, setTag] = useState<{ ar: string; en: string } | null>(null);
  const [iban, setIban] = useState('');
  const coverRef = useRef<HTMLInputElement>(null);

  const run = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name); setErr(null);
    try { const r = await fn(); if (r && typeof r === 'object' && 'listing' in r) qc.setQueryData(key, r); else await qc.invalidateQueries({ queryKey: key }); if (ok) toast({ tone: 'ok', text: ok }); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  };

  if (q.isLoading) return <LoadingState rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const l = d.listing;
  const v = d.verification;
  const tagline = tag ?? { ar: l.tagline_ar ?? '', en: l.tagline_en ?? '' };
  const docLocked = v.status === 'pending' || v.status === 'verified';
  const date = (x: string | null) => (x ? formatDateTime(x, { locale, time: false }) : '');

  const upload = (kind: string, file: File) => run(`doc:${kind}`, async () => {
    const form = new FormData();
    form.set('kind', kind); form.set('file', file);
    if (kind === 'iban') form.set('iban', iban);
    return api(`/api/v1/t/${slug}/marketplace/verification/documents`, { form });
  }, t('market.settings.uploaded'));

  const uploadCover = (file: File) => run('cover', async () => {
    const form = new FormData();
    form.set('purpose', 'cover'); form.set('file', file);
    const a = await api<{ id: string }>(`/api/v1/t/${slug}/assets`, { form });
    return api(`/api/v1/t/${slug}/marketplace`, { method: 'PATCH', body: { cover_asset_id: a.id } });
  }, t('states.saved'));

  return (
    <div className="flex flex-col gap-5">
      <FormErrorSummary message={err ? msg(err) : null} />
      <Card title={<span className="inline-flex items-center gap-2"><Store className="size-4 text-luma-700" aria-hidden />{t('market.settings.listing_title')}</span>}
        actions={<Badge tone={tone(l.status)}>{t(`market.listing_status.${l.status}`)}</Badge>}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">{t('market.settings.listing_intro')}</p>
          {d.visible ? (
            <Alert tone="ok">{t('market.settings.visible')} <Link href="/discover" className="underline">{t('market.settings.see_market')}</Link></Alert>
          ) : l.status === 'approved' && d.blockers.length ? (
            <Alert tone="warn" title={t('market.settings.not_visible')}><ul className="list-disc ps-5">{d.blockers.map((b) => <li key={b}>{t(`market.blockers.${b}`)}</li>)}</ul></Alert>
          ) : null}
          {l.status === 'rejected' && l.rejection_reason ? <Alert tone="danger" title={t('market.settings.rejected_title')}>{l.rejection_reason}</Alert> : null}
          {l.status === 'pending' ? <Alert tone="info">{t('market.settings.pending', { date: date(l.requested_at) })}</Alert> : null}
          {(l.status === 'draft' || l.status === 'rejected') ? (
            <div className="flex flex-col gap-2">
              {d.settings.require_verification && v.status !== 'verified' ? <p className="text-sm text-warn">{t('market.settings.verify_first')}</p> : null}
              <div><Button icon={<Send className="size-4" />} loading={busy === 'request'} disabled={!canManage || (d.settings.require_verification && v.status !== 'verified')}
                onClick={() => run('request', () => api(`/api/v1/t/${slug}/marketplace/request`, { body: {} }), t('market.settings.requested'))}>
                {l.status === 'rejected' ? t('market.settings.request_again') : t('market.settings.request')}
              </Button></div>
            </div>
          ) : null}
          {l.status === 'approved' ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <p className="flex-1 text-sm">{l.hidden ? t('market.settings.hidden_now') : t('market.settings.shown_now')}</p>
              <Button variant="secondary" icon={l.hidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />} loading={busy === 'hide'} disabled={!canManage}
                onClick={() => run('hide', () => api(`/api/v1/t/${slug}/marketplace`, { method: 'PATCH', body: { hidden: !l.hidden } }), t('states.saved'))}>
                {l.hidden ? t('market.settings.show') : t('market.settings.hide')}
              </Button>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('market.settings.tagline_ar')} hint={t('market.settings.tagline_hint')}>{(p) => <Input {...p} value={tagline.ar} maxLength={160} onChange={(e) => setTag({ ...tagline, ar: e.target.value })} />}</Field>
            <Field label={t('market.settings.tagline_en')}>{(p) => <Input {...p} dir="ltr" value={tagline.en} maxLength={160} onChange={(e) => setTag({ ...tagline, en: e.target.value })} />}</Field>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {tag ? <Button loading={busy === 'tag'} disabled={!canManage} onClick={() => run('tag', async () => { const r = await api(`/api/v1/t/${slug}/marketplace`, { method: 'PATCH', body: { tagline_ar: tagline.ar || null, tagline_en: tagline.en || null } }); setTag(null); return r; }, t('states.saved'))}>{t('actions.save')}</Button> : null}
            <div className="flex items-center gap-3">
              {l.cover_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={l.cover_url} alt="" className="h-14 w-24 rounded-lg object-cover" />
                : <span className="luma-pattern grid h-14 w-24 place-items-center rounded-lg bg-luma-100 text-[11px] text-ink-muted">{t('market.settings.no_cover')}</span>}
              <input ref={coverRef} type="file" accept="image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCover(f); e.target.value = ''; }} />
              <Button variant="secondary" icon={<Upload className="size-4" />} loading={busy === 'cover'} disabled={!canManage} onClick={() => coverRef.current?.click()}>{t('market.settings.cover')}</Button>
            </div>
          </div>
          <p className="text-xs text-ink-muted">{t('market.settings.commission_note', { pct: (l.commission_bp / 100).toLocaleString(locale === 'ar' ? 'ar-SA' : 'en-US') })}</p>
        </div>
      </Card>

      <Card title={<span className="inline-flex items-center gap-2"><BadgeCheck className="size-4 text-luma-700" aria-hidden />{t('market.settings.verify_title')}</span>}
        actions={<Badge tone={tone(v.status)}>{t(`market.verification_status.${v.status}`)}</Badge>}>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-muted">{t('market.settings.verify_intro')}</p>
          {v.status === 'verified' ? <Alert tone="ok">{t('market.settings.verified_on', { date: date(v.verified_at) })}</Alert> : null}
          {v.status === 'pending' ? <Alert tone="info">{t('market.settings.verify_pending')}</Alert> : null}
          {v.status === 'rejected' && v.rejection_reason ? <Alert tone="danger" title={t('market.settings.verify_rejected')}>{v.rejection_reason}</Alert> : null}
          <ul className="flex flex-col gap-3">
            {v.required.map((kind) => {
              const doc = v.documents.find((x) => x.kind === kind);
              return (
                <li key={kind} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileText className="size-4 text-luma-700" aria-hidden />
                    <span className="flex-1 font-medium">{t(`market.docs.${kind}`)}</span>
                    {doc ? <Badge tone="ok">{t('market.settings.uploaded_badge')}</Badge> : <Badge tone="warn">{t('market.settings.missing')}</Badge>}
                  </div>
                  <p className="text-xs text-ink-muted">{t(`market.docs_hint.${kind}`)}</p>
                  {doc ? (
                    <p className="text-xs">
                      <a className="text-luma-700 underline" href={`/api/v1/t/${slug}/marketplace/verification/documents/${doc.id}`} target="_blank" rel="noopener">{doc.file_name || t('market.settings.view_doc')}</a>
                      {doc.iban_masked ? <span className="ms-2" dir="ltr">{doc.iban_masked}</span> : null}
                      <span className="ms-2 text-ink-muted">{date(doc.created_at)}</span>
                    </p>
                  ) : null}
                  {!docLocked && canManage ? (
                    <div className="flex flex-wrap items-end gap-2">
                      {kind === 'iban' ? <Field label={t('market.settings.iban')} className="min-w-56 flex-1">{(p) => <Input {...p} dir="ltr" value={iban} placeholder="SA00 0000 0000 0000 0000 0000" maxLength={40} onChange={(e) => setIban(e.target.value)} />}</Field> : null}
                      <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-luma-300 px-3 py-2 text-sm text-luma-800 hover:bg-luma-50 ${kind === 'iban' && !iban.trim() ? 'pointer-events-none opacity-50' : ''}`}>
                        <Upload className="size-4" aria-hidden />{busy === `doc:${kind}` ? t('states.loading') : doc ? t('market.settings.replace') : t('market.settings.upload')}
                        <input type="file" accept="application/pdf,image/*" className="sr-only" disabled={kind === 'iban' && !iban.trim()} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(kind, f); e.target.value = ''; }} />
                      </label>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-ink-muted">{t('market.settings.private_note')}</p>
          {!docLocked ? (
            <div><Button icon={<Send className="size-4" />} loading={busy === 'submit'} disabled={!canManage || v.missing.length > 0}
              onClick={() => run('submit', () => api(`/api/v1/t/${slug}/marketplace/verification/submit`, { body: {} }), t('market.settings.submitted'))}>{t('market.settings.submit')}</Button></div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
