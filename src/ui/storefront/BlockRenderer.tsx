import type { ComponentType } from 'react';
import { cx } from '../components/cx';
import { BLOCKS, type BlockType, type PageBlock } from '@/shared/builder/blocks';
import { containerClass } from './theme';
import type { RenderCtx } from './context';
import { CtaBlock, FaqBlock, IntroBlock, PageLinkBlock, PoliciesBlock, SpacerBlock, TextBlock, WelcomeBlock } from './blocks/content';
import { CategoriesBlock, OffersBlock, ProductFeatureBlock, ProductGridBlock, ReviewsBlock, ServiceFeatureBlock, ServiceListBlock, TeamBlock } from './blocks/catalog';
import { ContactBlock, HoursBlock, MapBlock, SocialBlock } from './blocks/info';
import { GalleryBlock, HeroBlock, ImageAdBlock, ImageBlock, type BlockProps } from './blocks/media';

const RENDERERS: Record<Exclude<BlockType, 'columns'>, ComponentType<BlockProps>> = {
  hero: HeroBlock, image_ad: ImageAdBlock, image: ImageBlock, text: TextBlock, cta: CtaBlock, service_list: ServiceListBlock,
  service_feature: ServiceFeatureBlock, categories: CategoriesBlock, product_grid: ProductGridBlock, product_feature: ProductFeatureBlock,
  team: TeamBlock, gallery: GalleryBlock, offers: OffersBlock, reviews: ReviewsBlock, intro: IntroBlock, map: MapBlock, hours: HoursBlock,
  contact: ContactBlock, social: SocialBlock, faq: FaqBlock, policies: PoliciesBlock, page_link: PageLinkBlock, welcome: WelcomeBlock, spacer: SpacerBlock,
};

/** Responsive visibility flags → CSS classes publicly; evaluated directly in the canvas device preview. */
export function deviceHidden(ctx: RenderCtx, b: PageBlock) {
  if (ctx.canvas && ctx.device) return ctx.device === 'mobile' ? b.visibility.mobile === false : b.visibility.desktop === false;
  return false;
}
function deviceClass(ctx: RenderCtx, b: PageBlock) {
  if (ctx.canvas) return undefined;
  if (b.visibility.mobile === false && b.visibility.desktop === false) return 'hidden';
  if (b.visibility.mobile === false) return '@max-3xl:hidden';
  if (b.visibility.desktop === false) return '@3xl:hidden';
  return undefined;
}

/** Renders one block's content. Invalid/legacy props never break the page. */
export function RenderBlock({ ctx, block, pageBlocks, first }: { ctx: RenderCtx; block: PageBlock; pageBlocks: PageBlock[]; first?: boolean }) {
  const d = BLOCKS[block.type];
  if (!d) return null;
  if (d.feature === 'feature.products' && !ctx.data.features.products) return null;
  const parsed = d.props.safeParse(block.props);
  if (!parsed.success) return ctx.canvas ? <div className="m-4 rounded-sf border border-dashed border-red-400 p-4 text-sm text-red-700">{block.type}: invalid settings</div> : null;
  const props = parsed.data as Record<string, any>;
  if (block.type === 'columns') {
    const children = (block.children ?? []).filter((c) => c.visibility.enabled && !deviceHidden(ctx, c));
    if (!children.length && !ctx.canvas) return null;
    const gap = { sm: 'gap-3', md: 'gap-6', lg: 'gap-10' }[props.gap as string] ?? 'gap-6';
    const grid = props.count === 3 ? '@3xl:grid-cols-3' : '@3xl:grid-cols-2';
    return (
      <div id={block.id} className="px-4 @2xl:px-6">
        <div className={cx(containerClass, 'grid', gap, props.stack_on_mobile === false ? (props.count === 3 ? 'grid-cols-3' : 'grid-cols-2') : `grid-cols-1 ${grid}`)}>
          {children.map((c) => <div key={c.id} className={cx('min-w-0 [&_section]:px-0', deviceClass(ctx, c))}><RenderBlock ctx={ctx} block={c} pageBlocks={pageBlocks} /></div>)}
        </div>
      </div>
    );
  }
  const C = RENDERERS[block.type as Exclude<BlockType, 'columns'>];
  return <C ctx={ctx} block={block} props={props} pageBlocks={pageBlocks} first={first} />;
}

/** Public/preview page body: hidden sections (visibility.enabled=false) are never rendered. */
export function RenderBlocks({ ctx, blocks }: { ctx: RenderCtx; blocks: PageBlock[] }) {
  const shown = blocks.filter((b) => b.visibility.enabled);
  return (
    <>
      {shown.map((b, i) => {
        const cls = deviceClass(ctx, b);
        const el = <RenderBlock key={b.id} ctx={ctx} block={b} pageBlocks={blocks} first={i === 0} />;
        return cls ? <div key={b.id} className={cls}>{el}</div> : el;
      })}
    </>
  );
}
