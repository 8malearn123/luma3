import { ImageIcon } from 'lucide-react';
import { cx } from '../components/cx';
import { ASPECT } from './theme';
import { pk, type RenderCtx } from './context';

/**
 * Storefront image: fixed aspect ratio (no layout shift), object-fit cover with
 * a focal point (crop presets), lazy loading, explicit alt text. Missing or
 * removed images render a neutral placeholder in the canvas and nothing (or
 * the placeholder when `keepSpace`) publicly.
 */
export function SfImage({ ctx, id, alt, aspect = '4:3', focal = 'center', className, eager, keepSpace, rounded = true }: {
  ctx: RenderCtx; id: string | null | undefined; alt?: string; aspect?: string; focal?: string; className?: string; eager?: boolean; keepSpace?: boolean; rounded?: boolean;
}) {
  const meta = id ? ctx.data.assets[id] : undefined;
  const ratio = aspect === 'auto' ? (meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : '4 / 3') : (ASPECT[aspect] ?? '4 / 3');
  const pos = focal === 'start' ? (ctx.locale === 'ar' ? 'right' : 'left') : focal === 'end' ? (ctx.locale === 'ar' ? 'left' : 'right') : focal;
  if (!id || !meta) {
    if (!ctx.canvas && !keepSpace) return null;
    return (
      <div style={{ aspectRatio: ratio }} className={cx('flex w-full items-center justify-center bg-sf-border/40 text-sf-muted', rounded && 'rounded-sf', className)} aria-hidden={!ctx.canvas}>
        <ImageIcon className="size-8 opacity-60" aria-hidden />
      </div>
    );
  }
  const altText = alt ?? pk(ctx, meta.alt_ar, meta.alt_en);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/v1/media/${id}`} alt={altText} width={meta.width ?? undefined} height={meta.height ?? undefined}
      loading={eager ? 'eager' : 'lazy'} decoding="async" {...(eager ? { fetchPriority: 'high' as const } : {})}
      style={{ aspectRatio: ratio, objectPosition: pos }}
      className={cx('block h-auto w-full object-cover', rounded && 'rounded-sf', className)} />
  );
}
