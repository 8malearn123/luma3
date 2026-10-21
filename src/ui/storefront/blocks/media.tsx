import { CalendarCheck } from 'lucide-react';
import { cx } from '../../components/cx';
import type { PageBlock } from '@/shared/builder/blocks';
import { SfImage } from '../SfImage';
import { btnClass, containerClass, headingClass } from '../theme';
import { actionHref, L, tr, type RenderCtx } from '../context';
import { CanvasEmpty, Section } from './common';
import { GalleryGrid } from './Gallery';

type P = Record<string, any>;
export type BlockProps = { ctx: RenderCtx; block: PageBlock; props: P; pageBlocks: PageBlock[]; first?: boolean };

/** Wraps content in a link when the block has a (validated) action. */
export function ActionLink({ ctx, block, pageBlocks, children, className, label }: { ctx: RenderCtx; block: PageBlock; pageBlocks: PageBlock[]; children: React.ReactNode; className?: string; label?: string }) {
  const a = actionHref(ctx, block.action, pageBlocks);
  if (!a.href) return <div className={className}>{children}</div>;
  return (
    <a href={a.href} className={cx('block', className)} aria-label={label}
      {...(a.external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>{children}</a>
  );
}

export function HeroBlock({ ctx, block, props, pageBlocks, first }: BlockProps) {
  const h = { sm: 'min-h-[38vh]', md: 'min-h-[52vh]', lg: 'min-h-[68vh]' }[props.height as string] ?? 'min-h-[52vh]';
  const hasImage = !!props.image_asset_id && !!ctx.data.assets[props.image_asset_id];
  const a = actionHref(ctx, block.action ?? { type: 'start_booking' }, pageBlocks);
  const title = L(ctx, props.title) || ctx.data.tenant.name;
  const align = props.align === 'center' ? 'items-center text-center' : props.align === 'end' ? 'items-end text-end' : 'items-start text-start';
  return (
    <section id={block.id} className={cx('relative isolate flex overflow-hidden', h, hasImage ? 'text-white' : 'bg-sf-secondary/10')}>
      {hasImage ? (
        <>
          <div className="absolute inset-0 -z-10">
            <SfImage ctx={ctx} id={props.image_asset_id} alt="" aspect="16:9" focal={props.focal} eager={first} rounded={false} className="!h-full !aspect-auto" />
          </div>
          <div className="absolute inset-0 -z-10 bg-black" style={{ opacity: props.overlay ?? 0.35 }} aria-hidden />
        </>
      ) : null}
      <div className={cx(containerClass, 'flex flex-1 flex-col justify-center gap-4 px-4 py-12 @2xl:px-6', align)}>
        {first ? <h1 className={cx(headingClass, 'text-4xl font-bold @2xl:text-5xl', hasImage && '!text-white')}>{title}</h1>
          : <h2 className={cx(headingClass, 'text-3xl font-bold @2xl:text-4xl', hasImage && '!text-white')}>{title}</h2>}
        {L(ctx, props.subtitle) ? <p className={cx('max-w-2xl text-lg', hasImage ? 'text-white/90' : 'text-sf-muted')}>{L(ctx, props.subtitle)}</p> : null}
        {a.href ? (
          <a href={a.href} className={btnClass(ctx.data.brand, 'primary', 'lg')} {...(a.external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>
            {block.action?.type === 'start_booking' || !block.action ? <CalendarCheck className="size-5" aria-hidden /> : null}
            {L(ctx, props.cta_label) || tr(ctx, 'book_now')}
          </a>
        ) : ctx.data.mode === 'preview' ? <span className={cx(btnClass(ctx.data.brand, 'primary', 'lg'), 'opacity-70')} aria-disabled>{L(ctx, props.cta_label) || tr(ctx, 'book_now')}</span> : null}
      </div>
    </section>
  );
}

export function ImageAdBlock({ ctx, block, props, pageBlocks, first }: BlockProps) {
  if (!props.image_asset_id && !ctx.canvas) return null;
  const alt = L(ctx, props.alt) || L(ctx, props.caption);
  return (
    <Section id={block.id}>
      <ActionLink ctx={ctx} block={block} pageBlocks={pageBlocks} className="overflow-hidden rounded-sf">
        <figure>
          <SfImage ctx={ctx} id={props.image_asset_id} alt={alt} aspect={props.aspect} focal={props.focal} eager={first} />
          {L(ctx, props.caption) ? <figcaption className="mt-2 text-sm text-sf-muted">{L(ctx, props.caption)}</figcaption> : null}
        </figure>
      </ActionLink>
    </Section>
  );
}

export function ImageBlock({ ctx, block, props, pageBlocks, first }: BlockProps) {
  if (!props.image_asset_id && !ctx.canvas) return null;
  return (
    <div id={block.id} className="px-4 py-3 @2xl:px-6">
      <div className={containerClass}>
        <ActionLink ctx={ctx} block={block} pageBlocks={pageBlocks} className="overflow-hidden rounded-sf" label={block.action ? L(ctx, props.alt) || undefined : undefined}>
          <SfImage ctx={ctx} id={props.image_asset_id} alt={L(ctx, props.alt)} aspect={props.aspect} focal={props.focal} rounded={props.rounded !== false} eager={first} />
        </ActionLink>
      </div>
    </div>
  );
}

export function GalleryBlock({ ctx, block, props }: BlockProps) {
  const items = ((props.items ?? []) as Array<{ image_asset_id: string; alt?: { ar?: string; en?: string }; caption?: { ar?: string; en?: string } }>)
    .filter((i) => ctx.data.assets[i.image_asset_id])
    .map((i) => ({ id: i.image_asset_id, alt: L(ctx, i.alt) || L(ctx, i.caption) || (ctx.locale === 'ar' ? ctx.data.assets[i.image_asset_id]!.alt_ar : ctx.data.assets[i.image_asset_id]!.alt_en) || '', caption: L(ctx, i.caption) }));
  // An empty gallery is not rendered publicly (placeholder in the builder only).
  if (!items.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_gallery')} /></Section> : null;
  return (
    <Section id={block.id} title={L(ctx, props.title) || undefined}>
      <GalleryGrid items={items} layout={props.layout} columns={props.columns} lightbox={props.lightbox !== false && !ctx.canvas}
        labels={{ open: tr(ctx, 'gallery.open'), close: tr(ctx, 'gallery.close'), next: tr(ctx, 'gallery.next'), prev: tr(ctx, 'gallery.prev'), of: tr(ctx, 'gallery.of') }}
        rtl={ctx.locale === 'ar'} assets={Object.fromEntries(items.map((i) => [i.id, ctx.data.assets[i.id]!]))} />
    </Section>
  );
}
