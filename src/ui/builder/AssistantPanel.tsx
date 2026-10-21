'use client';

import { useState } from 'react';
import { Check, CircleSlash, Sparkles, Undo2, X } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Alert, Badge } from '../components/feedback';
import { Textarea } from '../components/form';
import { BLOCKS } from '@/shared/builder/blocks';
import type { DiffEntry, RejectedOp } from '@/shared/builder/assistant';
import { FONTS } from '@/shared/builder/theme';
import type { AiState, BuilderPage } from './types';

type Proposal = { id: string; status: string; explanation: string | null; diff: DiffEntry[]; rejected: RejectedOp[]; request_text: string };

function Swatch({ hex }: { hex: unknown }) {
  return typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex) ? <span className="inline-flex items-center gap-1 font-mono text-xs"><span className="inline-block size-3.5 rounded border border-line" style={{ background: hex }} />{hex}</span> : <span className="text-xs">{String(hex)}</span>;
}

/**
 * Natural-language customization: the server asks the AI for whitelisted
 * operations only, validates each, and returns a diff. Nothing changes until
 * the owner accepts; accepted changes go to the DRAFT only and can be undone.
 */
export function AssistantPanel({ slug, status, pages, beforePropose, onApplied }: { slug: string; status: AiState; pages: BuilderPage[]; beforePropose: () => Promise<boolean>; onApplied: () => void }) {
  const { t, locale, pick } = useI18n();
  const msg = useErrorMessage();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [accepted, setAccepted] = useState<Proposal | null>(null);

  if (status.state === 'plan_disabled') return <Alert tone="info" title={t('builder.assistant.plan_title')}>{t('builder.assistant.plan_body')}</Alert>;

  const connected = status.state === 'connected';
  const blockLabel = (d: DiffEntry) => {
    const page = pages.find((p) => p.id === d.page_id);
    return `${page ? pick(page.title_ar, page.title_en) : ''}${d.block_type ? ` · ${BLOCKS[d.block_type]?.label[locale] ?? d.block_type}` : ''}`;
  };
  const describe = (d: DiffEntry) => {
    switch (d.op) {
      case 'set_color': return <>{t(`builder.brand.colors.${d.target.split('.')[1]}`)}: <Swatch hex={d.before} /> → <Swatch hex={d.after} /></>;
      case 'set_font': return <>{t(`builder.brand.font_${d.target.split('.')[1]}`)}: {FONTS[d.before as keyof typeof FONTS]?.family} → {FONTS[d.after as keyof typeof FONTS]?.family}</>;
      case 'set_radius': case 'set_button_style': case 'set_card_style': case 'set_density': case 'set_nav_style':
        return <>{t(`builder.assistant.targets.${d.target}`)}: {t(`builder.o.${String(d.before)}`)} → {t(`builder.o.${String(d.after)}`)}</>;
      case 'move_block': {
        const after = d.after as string[];
        return <>{t('builder.assistant.moved', { block: blockLabel(d), pos: after.indexOf(d.block_id!) + 1, total: after.length })}</>;
      }
      case 'set_block_visibility': return <>{blockLabel(d)}: {d.after ? t('builder.canvas.show') : t('builder.canvas.hide')}</>;
      case 'set_text': {
        const a = d.after as { ar?: string; en?: string }; const b = d.before as { ar?: string; en?: string };
        return <>{blockLabel(d)} — {t(`builder.f.${d.target.split('.').pop()}`)}: “{(locale === 'ar' ? b?.ar ?? b?.en : b?.en ?? b?.ar) || '—'}” → “{(locale === 'ar' ? a?.ar ?? a?.en : a?.en ?? a?.ar) || '—'}”</>;
      }
    }
  };

  async function propose() {
    setBusy('propose'); setErr(null); setProposal(null);
    try {
      if (!(await beforePropose())) throw new Error('save_failed');
      setProposal(await api<Proposal>(`/api/v1/t/${slug}/builder/proposals`, { body: { request_text: text } }));
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }
  async function decide(kind: 'accept' | 'reject') {
    if (!proposal) return;
    setBusy(kind); setErr(null);
    try {
      const r = await api<Proposal>(`/api/v1/t/${slug}/builder/proposals/${proposal.id}/${kind}`, { body: {} });
      if (kind === 'accept') { setAccepted(r); onApplied(); }
      setProposal(null);
    } catch (e) { setErr(e); } finally { setBusy(null); }
  }
  async function undo() {
    if (!accepted) return;
    setBusy('undo'); setErr(null);
    try { await beforePropose(); await api(`/api/v1/t/${slug}/builder/proposals/${accepted.id}/undo`, { body: {} }); setAccepted(null); onApplied(); }
    catch (e) { setErr(e); } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-luma-700" aria-hidden />
        <span className="text-sm font-semibold">{t('builder.assistant.title')}</span>
        <Badge tone={connected ? 'ok' : 'warn'}>{connected ? t('builder.assistant.connected') : t('builder.assistant.disconnected')}</Badge>
      </div>
      {!connected ? <Alert tone="warn">{t('builder.assistant.disconnected_body')}</Alert> : <p className="text-xs text-ink-muted">{t('builder.assistant.scope')}</p>}
      <label className="text-sm font-medium" htmlFor="assistant-req">{t('builder.assistant.label')}</label>
      <Textarea id="assistant-req" rows={4} maxLength={1000} value={text} disabled={!connected} placeholder={t('builder.assistant.placeholder')} onChange={(e) => setText(e.target.value)} />
      <Button icon={<Sparkles className="size-4" />} disabled={!connected || text.trim().length < 3} loading={busy === 'propose'} onClick={propose}>{t('builder.assistant.propose')}</Button>
      {err ? <Alert tone="danger">{msg(err)}</Alert> : null}
      {proposal ? (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3">
          {proposal.explanation ? <p className="text-sm">{proposal.explanation}</p> : null}
          {proposal.diff.length ? (
            <>
              <p className="text-xs font-semibold text-ink-muted">{t('builder.assistant.changes')}</p>
              <ul className="flex flex-col gap-1 text-sm">{proposal.diff.map((d) => <li key={d.index} className="flex gap-1"><Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden /><span>{describe(d)}</span></li>)}</ul>
            </>
          ) : null}
          {proposal.rejected.length ? (
            <>
              <p className="text-xs font-semibold text-ink-muted">{t('builder.assistant.rejected')}</p>
              <ul className="flex flex-col gap-1 text-xs text-ink-muted">{proposal.rejected.map((r) => <li key={r.index} className="flex gap-1"><CircleSlash className="mt-0.5 size-3.5 shrink-0" aria-hidden />{r.op}: {t(`builder.assistant.reasons.${r.reason}`)}</li>)}</ul>
            </>
          ) : null}
          <p className="text-xs text-ink-muted">{t('builder.assistant.draft_only')}</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={proposal.status !== 'proposed'} loading={busy === 'accept'} icon={<Check className="size-4" />} onClick={() => decide('accept')}>{t('builder.assistant.accept')}</Button>
            <Button size="sm" variant="ghost" disabled={proposal.status !== 'proposed'} loading={busy === 'reject'} icon={<X className="size-4" />} onClick={() => decide('reject')}>{t('builder.assistant.reject')}</Button>
          </div>
        </div>
      ) : null}
      {accepted ? (
        <Alert tone="ok" title={t('builder.assistant.applied')}>
          <Button size="sm" variant="outline" className="mt-2" loading={busy === 'undo'} icon={<Undo2 className="size-4" />} onClick={undo}>{t('builder.assistant.undo')}</Button>
        </Alert>
      ) : null}
    </div>
  );
}
