import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cx } from '../../components/cx';
import type { RichText as RichTextValue } from '@/shared/builder/blocks';
import { containerClass, headingClass, sectionClass } from '../theme';
import { tr, type RenderCtx } from '../context';

export function Section({ id, title, children, className, tone = 'none', wide }: { id: string; title?: string; children: ReactNode; className?: string; tone?: string; wide?: boolean }) {
  const bg = tone === 'surface' ? 'bg-sf-surface' : tone === 'primary' ? 'bg-sf-primary text-sf-on-primary' : tone === 'secondary' ? 'bg-sf-secondary/15' : tone === 'accent' ? 'bg-sf-accent/15' : '';
  return (
    <section id={id} aria-labelledby={title ? `${id}-h` : undefined} className={cx(sectionClass, bg, className)}>
      <div className={cx(containerClass, wide && 'max-w-7xl')}>
        {title ? <h2 id={`${id}-h`} className={cx(headingClass, 'mb-[calc(var(--sf-space)*1.25rem)] text-2xl font-semibold @2xl:text-3xl', tone === 'primary' && 'text-sf-on-primary')}>{title}</h2> : null}
        {children}
      </div>
    </section>
  );
}

/** Builder-only placeholder for blocks that have nothing to show yet (hidden publicly). */
export function CanvasEmpty({ ctx, label }: { ctx: RenderCtx; label: string }) {
  if (!ctx.canvas) return null;
  return <div className="rounded-sf border-2 border-dashed border-sf-border p-6 text-center text-sm text-sf-muted">{label}</div>;
}

/** Shown when a block points at something archived or hidden (builder warns; customers see this calm fallback). */
export function Unavailable({ ctx, href, label }: { ctx: RenderCtx; href?: string | null; label?: string }) {
  return (
    <div className="flex items-start gap-2 rounded-sf border border-sf-border bg-sf-surface p-4 text-sm text-sf-muted" role="note">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>{label ?? tr(ctx, 'unavailable')}{href ? <> <a className="font-medium text-sf-primary underline" href={href}>{tr(ctx, 'see_all')}</a></> : null}</p>
    </div>
  );
}

type Inline = { text: string; bold?: boolean; italic?: boolean; href?: string };
function Runs({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((r, i) => {
        let el: ReactNode = r.text;
        if (r.bold) el = <strong>{el}</strong>;
        if (r.italic) el = <em>{el}</em>;
        if (r.href) el = <a href={r.href} className="text-sf-primary underline" rel="noopener noreferrer nofollow" target="_blank">{el}</a>;
        return <span key={i} className="whitespace-pre-line">{el}</span>;
      })}
    </>
  );
}

/** Renders the restricted rich-text structure (never raw HTML). */
export function RichText({ ctx, value, className }: { ctx: RenderCtx; value: RichTextValue | undefined; className?: string }) {
  const nodes = (ctx.locale === 'ar' ? value?.ar?.length ? value.ar : value?.en : value?.en?.length ? value.en : value?.ar) ?? [];
  if (!nodes.length) return null;
  return (
    <div className={cx('flex flex-col gap-3 leading-relaxed', className)}>
      {nodes.map((n, i) => {
        if (n.t === 'p') return <p key={i}><Runs c={n.c} /></p>;
        if (n.t === 'h2') return <h2 key={i} className={cx(headingClass, 'text-2xl font-semibold')}><Runs c={n.c} /></h2>;
        if (n.t === 'h3') return <h3 key={i} className={cx(headingClass, 'text-xl font-semibold')}><Runs c={n.c} /></h3>;
        if (n.t === 'ul') return <ul key={i} className="list-disc ps-6">{n.items.map((it, k) => <li key={k}><Runs c={it} /></li>)}</ul>;
        return <ol key={i} className="list-decimal ps-6">{n.items.map((it, k) => <li key={k}><Runs c={it} /></li>)}</ol>;
      })}
    </div>
  );
}

export function cols(n: number) {
  return ({ 1: 'grid-cols-1', 2: 'grid-cols-1 @2xl:grid-cols-2', 3: 'grid-cols-1 @2xl:grid-cols-2 @5xl:grid-cols-3', 4: 'grid-cols-2 @5xl:grid-cols-4', 5: 'grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-5' } as Record<number, string>)[n] ?? 'grid-cols-1 @2xl:grid-cols-2';
}

export const alignClass = (a: string | undefined) => (a === 'center' ? 'text-center items-center' : a === 'end' ? 'text-end items-end' : 'text-start items-start');
