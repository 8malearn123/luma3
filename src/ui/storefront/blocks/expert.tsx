import { Camera, ExternalLink, PartyPopper } from 'lucide-react';
import { cx } from '../../components/cx';
import type { PublicPortfolioItem, StorefrontData } from '@/shared/builder/storefront';
import { btnClass, cardClass, headingClass } from '../theme';
import { L, tr, type RenderCtx } from '../context';
import { CanvasEmpty, cols, Section } from './common';
import type { BlockProps } from './media';
import { BeforeAfterSlider } from './BeforeAfterSlider';

type Loc = { ar?: string; en?: string };
export type BeforeAfterView = { key: string; before: string; after: string; caption: string; category: string };

/**
 * Before/after items for a block (pure; also used by tests and the canvas).
 * Hand-picked pairs, or the portfolio (pairs only, optionally by category).
 * Items whose images are not public and ready are dropped.
 */
export function beforeAfterItems(data: Pick<StorefrontData, 'assets' | 'portfolio'>, locale: 'ar' | 'en', props: {
  source?: string; category?: string | null; limit?: number; items?: Array<{ before_asset_id: string; after_asset_id: string; caption?: Loc; category?: Loc }>;
}): BeforeAfterView[] {
  const ok = (id: string | null | undefined): id is string => !!id && !!data.assets[id];
  const L2 = (v?: Loc) => (v ? (locale === 'ar' ? v.ar || v.en : v.en || v.ar) ?? '' : '');
  let out: BeforeAfterView[];
  if (props.source === 'portfolio') {
    const cat = props.category?.trim().toLowerCase();
    out = (data.portfolio ?? [])
      .filter((p: PublicPortfolioItem) => ok(p.before_asset_id) && ok(p.after_asset_id) && (!cat || (p.category ?? '').trim().toLowerCase() === cat))
      .map((p) => ({ key: p.id, before: p.before_asset_id!, after: p.after_asset_id, caption: (locale === 'ar' ? p.caption_ar || p.caption_en : p.caption_en || p.caption_ar) ?? '', category: p.category ?? '' }));
  } else {
    out = (props.items ?? []).filter((i) => ok(i.before_asset_id) && ok(i.after_asset_id))
      .map((i, n) => ({ key: `${n}-${i.before_asset_id}`, before: i.before_asset_id, after: i.after_asset_id, caption: L2(i.caption), category: L2(i.category) }));
  }
  return out.slice(0, props.limit ?? 12);
}

export function BeforeAfterBlock({ ctx, block, props, first }: BlockProps) {
  const title = L(ctx, props.title) || undefined;
  const items = beforeAfterItems(ctx.data, ctx.locale, props);
  if (!items.length) return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'expert.ba.empty')} /></Section> : null;
  const rtl = ctx.locale === 'ar';
  return (
    <Section id={block.id} title={title}>
      <ul className={cx('grid gap-4', cols(props.columns ?? 2))}>
        {items.map((it, i) => {
          const name = it.caption || tr(ctx, 'expert.ba.item', { n: i + 1 });
          return (
            <li key={it.key}>
              <figure className="flex flex-col gap-2">
                <BeforeAfterSlider beforeSrc={`/api/v1/media/${it.before}`} afterSrc={`/api/v1/media/${it.after}`} rtl={rtl} start={props.start ?? 50}
                  showLabels={props.show_labels !== false} eager={first && i === 0}
                  beforeAlt={tr(ctx, 'expert.ba.before_alt', { name })} afterAlt={tr(ctx, 'expert.ba.after_alt', { name })}
                  labels={{ before: tr(ctx, 'expert.ba.before'), after: tr(ctx, 'expert.ba.after'), slider: tr(ctx, 'expert.ba.slider', { name }), valueText: tr(ctx, 'expert.ba.value_text') }} />
                {it.caption || it.category ? (
                  <figcaption className="flex flex-wrap items-center gap-2 text-sm">
                    {it.caption ? <span>{it.caption}</span> : null}
                    {it.category ? <span className="rounded-full bg-sf-secondary/15 px-2 py-0.5 text-xs text-sf-muted">{it.category}</span> : null}
                  </figcaption>
                ) : null}
              </figure>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** What the Instagram block shows (pure): posts while connected, otherwise the follow card (or nothing without a handle). */
export function instagramView(data: Pick<StorefrontData, 'instagram' | 'contact'>, limit: number): { mode: 'posts' | 'follow' | 'none'; handle: string | null; url: string | null; posts: NonNullable<StorefrontData['instagram']>['posts'] } {
  const ig = data.instagram;
  const url = ig?.profile_url ?? data.contact.social.instagram ?? null;
  const handle = ig?.handle ?? (url ? url.replace(/\/+$/, '').split('/').pop() ?? null : null);
  if (ig?.connected && ig.posts.length) return { mode: 'posts', handle, url, posts: ig.posts.slice(0, limit) };
  return { mode: url ? 'follow' : 'none', handle, url, posts: [] };
}

export function InstagramBlock({ ctx, block, props }: BlockProps) {
  const title = L(ctx, props.title) || undefined;
  const v = instagramView(ctx.data, props.limit ?? 6);
  if (v.mode === 'none') return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'expert.ig.empty')} /></Section> : null;
  const follow = L(ctx, props.follow_text) || tr(ctx, 'expert.ig.follow');
  const link = v.url && !ctx.canvas ? { href: v.url, target: '_blank', rel: 'noopener noreferrer nofollow' } : {};
  if (v.mode === 'follow') {
    return (
      <Section id={block.id}>
        <div className={cx(cardClass(ctx.data.brand), 'mx-auto flex max-w-xl flex-col items-center gap-3 overflow-hidden p-8 text-center')}>
          <span className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-tr from-[#f9ce34] via-[#ee2a7b] to-[#6228d7] text-white" aria-hidden><Camera className="size-7" /></span>
          <h2 className={cx(headingClass, 'text-2xl font-semibold')}>{title ?? tr(ctx, 'expert.ig.follow_title')}</h2>
          {v.handle ? <p className="text-sf-muted" dir="ltr">@{v.handle}</p> : null}
          <a {...link} className={btnClass(ctx.data.brand, 'primary')}>{follow}<ExternalLink className="size-4" aria-hidden /></a>
        </div>
      </Section>
    );
  }
  const slug = ctx.data.tenant.slug;
  return (
    <Section id={block.id} title={title}>
      <ul className={cx('grid gap-2', props.columns === 2 ? 'grid-cols-2' : props.columns === 4 ? 'grid-cols-2 @2xl:grid-cols-4' : 'grid-cols-2 @2xl:grid-cols-3')}>
        {v.posts.map((p) => {
          const alt = p.caption ? p.caption.slice(0, 120) : tr(ctx, 'expert.ig.post_alt', { handle: v.handle ?? '' });
          return (
            <li key={p.id}>
              <a href={ctx.canvas ? undefined : p.permalink} target="_blank" rel="noopener noreferrer nofollow" className="block overflow-hidden rounded-sf focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-label={tr(ctx, 'expert.ig.open_post', { caption: alt })}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/v1/s/${slug}/instagram/${encodeURIComponent(p.id)}`} alt={alt} loading="lazy" decoding="async" className="aspect-square w-full object-cover transition-transform hover:scale-105" />
              </a>
            </li>
          );
        })}
      </ul>
      {props.show_follow !== false && v.url ? (
        <div className="mt-4 flex justify-center"><a {...link} className={btnClass(ctx.data.brand, 'outline', 'sm')}>{follow}{v.handle ? <bdi dir="ltr">@{v.handle}</bdi> : null}</a></div>
      ) : null}
    </Section>
  );
}

export function hrefEvents(ctx: RenderCtx) {
  return ctx.data.mode === 'preview' ? null : `/s/${ctx.data.tenant.slug}/events`;
}

export function EventRequestBlock({ ctx, block, props }: BlockProps) {
  if (ctx.data.events && !ctx.data.events.enabled) return ctx.canvas ? <Section id={block.id}><CanvasEmpty ctx={ctx} label={tr(ctx, 'expert.ev.disabled')} /></Section> : null;
  const href = hrefEvents(ctx);
  const title = L(ctx, props.title) || tr(ctx, 'expert.ev.title');
  const body = L(ctx, props.body);
  const label = L(ctx, props.label) || tr(ctx, 'expert.ev.cta');
  const btn = href && !ctx.canvas ? <a href={href} className={btnClass(ctx.data.brand, 'primary')}>{label}</a> : <span className={cx(btnClass(ctx.data.brand, 'primary'), 'opacity-80')} aria-disabled>{label}</span>;
  const deposit = ctx.data.events?.default_deposit_bp ? tr(ctx, 'expert.ev.deposit_note', { pct: Math.round(ctx.data.events.default_deposit_bp / 100) }) : '';
  if (props.style === 'banner') {
    return (
      <section id={block.id} className="bg-sf-primary px-4 py-8 text-sf-on-primary @2xl:px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-center @2xl:flex-row @2xl:text-start">
          <div><h2 className={cx(headingClass, '!text-sf-on-primary text-2xl font-semibold')}>{title}</h2>{body ? <p className="mt-1 opacity-90">{body}</p> : null}</div>
          {href && !ctx.canvas ? <a href={href} className={cx(btnClass(ctx.data.brand, 'secondary'), '!bg-white !text-black')}>{label}</a> : null}
        </div>
      </section>
    );
  }
  return (
    <Section id={block.id}>
      <div className={cx(cardClass(ctx.data.brand), 'flex flex-col items-center gap-3 p-6 text-center @2xl:p-10')}>
        <PartyPopper className="size-8 text-sf-primary" aria-hidden />
        <h2 className={cx(headingClass, 'text-2xl font-semibold')}>{title}</h2>
        {body ? <p className="max-w-xl text-sf-muted">{body}</p> : null}
        {btn}
        {deposit ? <p className="text-xs text-sf-muted">{deposit}</p> : null}
      </div>
    </Section>
  );
}

