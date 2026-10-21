import { ChevronDown, FileText, ShieldCheck } from 'lucide-react';
import { cx } from '../../components/cx';
import { richIsEmpty } from '@/shared/builder/richtext';
import { SfImage } from '../SfImage';
import { btnClass, cardClass, containerClass, headingClass } from '../theme';
import { actionHref, hrefPage, hrefPolicies, L, pageById, pk, tr } from '../context';
import { alignClass, CanvasEmpty, RichText, Section, Unavailable } from './common';
import { ActionLink, type BlockProps } from './media';
import { WelcomeBanner } from './Welcome';

export function TextBlock({ ctx, block, props }: BlockProps) {
  if (richIsEmpty(props.content)) return ctx.canvas ? <Section id={block.id}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_text')} /></Section> : null;
  return (
    <Section id={block.id} tone={props.background}>
      <RichText ctx={ctx} value={props.content} className={cx('max-w-3xl', props.align === 'center' && 'mx-auto text-center', props.align === 'end' && 'ms-auto text-end')} />
    </Section>
  );
}

export function CtaBlock({ ctx, block, props, pageBlocks }: BlockProps) {
  const a = actionHref(ctx, block.action ?? { type: 'start_booking' }, pageBlocks);
  const label = L(ctx, props.label) || tr(ctx, 'book_now');
  const cls = cx(btnClass(ctx.data.brand, props.style === 'secondary' ? 'secondary' : props.style === 'outline' ? 'outline' : 'primary', 'lg'), props.full_width && 'w-full');
  return (
    <div id={block.id} className="px-4 py-4 @2xl:px-6">
      <div className={cx(containerClass, 'flex flex-col', alignClass(props.align))}>
        {a.href ? <a href={a.href} className={cls} {...(a.external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>{label}</a>
          : <span className={cx(cls, 'opacity-70')} aria-disabled>{label}</span>}
      </div>
    </div>
  );
}

export function IntroBlock({ ctx, block, props, pageBlocks }: BlockProps) {
  const hasImg = props.layout !== 'text_only' && (!!props.image_asset_id || ctx.canvas);
  if (richIsEmpty(props.body) && !L(ctx, props.title)) return ctx.canvas ? <Section id={block.id}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_text')} /></Section> : null;
  return (
    <Section id={block.id}>
      <div className={cx('grid items-center gap-6', hasImg && '@3xl:grid-cols-2')}>
        {hasImg ? (
          <div className={cx(props.layout === 'image_end' && '@3xl:order-2')}>
            <SfImage ctx={ctx} id={props.image_asset_id} aspect="4:3" />
          </div>
        ) : null}
        <div className="flex flex-col gap-3">
          {L(ctx, props.title) ? <h2 className={cx(headingClass, 'text-2xl font-semibold @2xl:text-3xl')}>{L(ctx, props.title)}</h2> : null}
          <RichText ctx={ctx} value={props.body} className="text-sf-text/90" />
          {block.action ? <ActionLink ctx={ctx} block={block} pageBlocks={pageBlocks} className="mt-2 self-start"><span className={btnClass(ctx.data.brand, 'outline', 'sm')}>{tr(ctx, 'learn_more')}</span></ActionLink> : null}
        </div>
      </div>
    </Section>
  );
}

export function WelcomeBlock({ ctx, block, props, pageBlocks }: BlockProps) {
  const msg = L(ctx, props.message);
  if (!msg) return null;
  const a = actionHref(ctx, block.action, pageBlocks);
  return <WelcomeBanner id={block.id} message={msg} style={props.style} dismissible={props.dismissible !== false && !ctx.canvas} href={a.href} closeLabel={tr(ctx, 'dismiss')} card={cardClass(ctx.data.brand)} />;
}

export function SpacerBlock({ block, props }: BlockProps) {
  const h = { sm: 'h-4', md: 'h-10', lg: 'h-20' }[props.size as string] ?? 'h-10';
  return (
    <div id={block.id} className={cx('flex items-center px-4 @2xl:px-6', h)} aria-hidden>
      {props.divider ? <hr className={cx(containerClass, 'border-sf-border')} /> : null}
    </div>
  );
}

export function FaqBlock({ ctx, block, props }: BlockProps) {
  const items = ((props.items ?? []) as Array<{ q: { ar?: string; en?: string }; a: { ar?: string; en?: string } }>).filter((i) => L(ctx, i.q));
  if (!items.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || tr(ctx, 'faq')}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_faq')} /></Section> : null;
  return (
    <Section id={block.id} title={L(ctx, props.title) || tr(ctx, 'faq')}>
      <div className="flex flex-col gap-2">
        {items.map((i, k) => (
          <details key={k} className={cx(cardClass(ctx.data.brand), 'group p-4')}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-medium [&::-webkit-details-marker]:hidden">
              <span>{L(ctx, i.q)}</span>
              <ChevronDown className="size-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <p className="mt-2 whitespace-pre-line text-sf-muted">{L(ctx, i.a)}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

export function PageLinkBlock({ ctx, block, props }: BlockProps) {
  const page = pageById(ctx, props.page_id);
  if (!page) return ctx.canvas ? <Section id={block.id}><Unavailable ctx={ctx} /></Section> : null;
  const label = L(ctx, props.label) || pk(ctx, page.title_ar, page.title_en);
  return (
    <div id={block.id} className="px-4 py-3 @2xl:px-6">
      <a href={hrefPage(ctx, page)} className={cx(containerClass, cardClass(ctx.data.brand), 'flex items-center gap-4 p-4 hover:brightness-[0.98]')}>
        {props.image_asset_id ? <div className="w-24 shrink-0"><SfImage ctx={ctx} id={props.image_asset_id} aspect="1:1" /></div> : <FileText className="size-6 shrink-0 text-sf-primary" aria-hidden />}
        <div>
          <p className={cx(headingClass, 'font-semibold')}>{label}</p>
          {L(ctx, props.description) ? <p className="text-sm text-sf-muted">{L(ctx, props.description)}</p> : null}
        </div>
      </a>
    </div>
  );
}

export function PoliciesBlock({ ctx, block, props }: BlockProps) {
  const chosen = ((props.page_ids ?? []) as string[]).map((id) => pageById(ctx, id)).filter(Boolean);
  const pages = chosen.length ? chosen : ctx.data.pages.filter((p) => ['booking_policy', 'privacy', 'returns'].includes(p.kind));
  return (
    <Section id={block.id} title={L(ctx, props.title) || tr(ctx, 'policies')}>
      <ul className="flex flex-wrap gap-2">
        {pages.map((p) => (
          <li key={p!.id}><a href={hrefPage(ctx, p!)} className={cx(cardClass(ctx.data.brand), 'inline-flex items-center gap-2 px-4 py-2 text-sm hover:brightness-[0.98]')}><ShieldCheck className="size-4 text-sf-primary" aria-hidden />{pk(ctx, p!.title_ar, p!.title_en)}</a></li>
        ))}
        <li><a href={hrefPolicies(ctx)} className="inline-flex items-center px-2 py-2 text-sm text-sf-primary underline">{tr(ctx, 'all_policies')}</a></li>
      </ul>
    </Section>
  );
}
