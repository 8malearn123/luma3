import { CalendarCheck, Clock, ShoppingBag, Star, UserRound } from 'lucide-react';
import { cx } from '../../components/cx';
import type { PublicProduct, PublicService, PublicStaff } from '@/shared/builder/storefront';
import { formatDuration } from '@/shared/format';
import { SfImage } from '../SfImage';
import { btnClass, cardClass, headingClass } from '../theme';
import {
  hrefBooking, hrefCart, hrefProduct, hrefProducts, hrefService, hrefServices, hrefStaff, L, money, pk, productById, serviceById, tr, type RenderCtx,
} from '../context';
import { CanvasEmpty, cols, Section, Unavailable } from './common';
import type { BlockProps } from './media';

export function priceLabel(ctx: RenderCtx, s: Pick<PublicService, 'price_minor' | 'price_display'>) {
  return s.price_display === 'starting_from' ? tr(ctx, 'from_price', { price: money(ctx, s.price_minor) }) : money(ctx, s.price_minor);
}

export function BookButton({ ctx, serviceId, staffId, size = 'sm', label }: { ctx: RenderCtx; serviceId?: string | null; staffId?: string | null; size?: 'sm' | 'md' | 'lg'; label?: string }) {
  const href = hrefBooking(ctx, { service: serviceId, staff: staffId });
  const text = label ?? tr(ctx, 'book');
  if (!href) return <span className={cx(btnClass(ctx.data.brand, 'primary', size), 'opacity-60')} aria-disabled title={tr(ctx, 'preview_booking_disabled')}>{text}</span>;
  return <a href={href} className={btnClass(ctx.data.brand, 'primary', size)}><CalendarCheck className="size-4" aria-hidden />{text}</a>;
}

export function ServiceCard({ ctx, s, display, showPrice = true, showDuration = true }: { ctx: RenderCtx; s: PublicService; display: 'list' | 'cards'; showPrice?: boolean; showDuration?: boolean }) {
  const name = pk(ctx, s.name_ar, s.name_en);
  const desc = pk(ctx, s.description_ar, s.description_en);
  if (display === 'list') {
    return (
      <li className="flex items-center justify-between gap-3 border-b border-sf-border py-3 last:border-b-0">
        <div className="min-w-0">
          <h3 className="font-semibold"><a href={hrefService(ctx, s.id)} className="hover:underline">{name}</a></h3>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-sf-muted">
            {showDuration ? <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden />{formatDuration(s.duration_min, ctx.locale)}</span> : null}
            {showPrice ? <span className="font-medium text-sf-text">{priceLabel(ctx, s)}</span> : null}
          </p>
        </div>
        <BookButton ctx={ctx} serviceId={s.id} />
      </li>
    );
  }
  return (
    <li className={cx(cardClass(ctx.data.brand), 'flex flex-col overflow-hidden')}>
      {s.image_asset_id && ctx.data.assets[s.image_asset_id] ? <a href={hrefService(ctx, s.id)} tabIndex={-1} aria-hidden><SfImage ctx={ctx} id={s.image_asset_id} alt="" aspect="4:3" rounded={false} /></a> : null}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className={cx(headingClass, 'text-lg font-semibold')}><a href={hrefService(ctx, s.id)} className="hover:underline">{name}</a></h3>
        {desc ? <p className="line-clamp-2 text-sm text-sf-muted">{desc}</p> : null}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
          <p className="flex flex-col text-sm">
            {showPrice ? <span className="font-semibold">{priceLabel(ctx, s)}</span> : null}
            {showDuration ? <span className="inline-flex items-center gap-1 text-sf-muted"><Clock className="size-3.5" aria-hidden />{formatDuration(s.duration_min, ctx.locale)}</span> : null}
          </p>
          <BookButton ctx={ctx} serviceId={s.id} />
        </div>
      </div>
    </li>
  );
}

export function ServiceGrid({ ctx, services, display, columns, showPrice, showDuration }: { ctx: RenderCtx; services: PublicService[]; display: 'list' | 'cards'; columns: number; showPrice?: boolean; showDuration?: boolean }) {
  return display === 'list'
    ? <ul className={cx(cardClass(ctx.data.brand), 'px-4')}>{services.map((s) => <ServiceCard key={s.id} ctx={ctx} s={s} display="list" showPrice={showPrice} showDuration={showDuration} />)}</ul>
    : <ul className={cx('grid gap-4', cols(columns))}>{services.map((s) => <ServiceCard key={s.id} ctx={ctx} s={s} display="cards" showPrice={showPrice} showDuration={showDuration} />)}</ul>;
}

export function selectServices(ctx: RenderCtx, props: { service_ids?: string[]; category_id?: string | null }) {
  const all = ctx.data.catalog.services;
  if (props.service_ids?.length) return props.service_ids.map((id) => all.find((s) => s.id === id)).filter((s): s is PublicService => !!s);
  if (props.category_id) return all.filter((s) => s.category_id === props.category_id);
  return all;
}

export function ServiceListBlock({ ctx, block, props }: BlockProps) {
  const list = selectServices(ctx, props);
  const title = L(ctx, props.title) || undefined;
  if (!list.length) {
    // Booking never depends on this block: the header/floating Book entry stays available.
    return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_services')} /></Section> : null;
  }
  const display = props.display === 'list' ? 'list' : 'cards';
  if (props.group_by_category && !props.service_ids?.length) {
    const groups = [...ctx.data.catalog.categories.filter((c) => c.kind === 'service').map((c) => ({ id: c.id, name: pk(ctx, c.name_ar, c.name_en), items: list.filter((s) => s.category_id === c.id) })),
      { id: 'other', name: tr(ctx, 'other_services'), items: list.filter((s) => !s.category_id || !ctx.data.catalog.categories.some((c) => c.id === s.category_id)) }].filter((g) => g.items.length);
    return (
      <Section id={block.id} title={title}>
        <div className="flex flex-col gap-8">
          {groups.map((g) => (
            <div key={g.id}>
              {groups.length > 1 ? <h3 className={cx(headingClass, 'mb-3 text-xl font-semibold')}>{g.name}</h3> : null}
              <ServiceGrid ctx={ctx} services={g.items} display={display} columns={props.columns ?? 2} showPrice={props.show_prices !== false} showDuration={props.show_durations !== false} />
            </div>
          ))}
        </div>
      </Section>
    );
  }
  return (
    <Section id={block.id} title={title}>
      <ServiceGrid ctx={ctx} services={list} display={display} columns={props.columns ?? 2} showPrice={props.show_prices !== false} showDuration={props.show_durations !== false} />
    </Section>
  );
}

export function ServiceFeatureBlock({ ctx, block, props }: BlockProps) {
  const s = serviceById(ctx, props.service_id);
  if (!s) return <Section id={block.id}><Unavailable ctx={ctx} href={hrefServices(ctx)} label={tr(ctx, 'service_unavailable')} /></Section>;
  const name = pk(ctx, s.name_ar, s.name_en);
  const img = s.image_asset_id && ctx.data.assets[s.image_asset_id];
  return (
    <Section id={block.id}>
      <div className={cx(cardClass(ctx.data.brand), 'grid gap-0 overflow-hidden', img && props.layout !== 'stacked' && '@3xl:grid-cols-2')}>
        {img ? <div className={cx(props.layout === 'image_end' && '@3xl:order-2')}><SfImage ctx={ctx} id={s.image_asset_id} alt={name} aspect="4:3" rounded={false} /></div> : null}
        <div className="flex flex-col justify-center gap-3 p-6">
          <h3 className={cx(headingClass, 'text-2xl font-semibold')}><a href={hrefService(ctx, s.id)} className="hover:underline">{name}</a></h3>
          {pk(ctx, s.description_ar, s.description_en) ? <p className="text-sf-muted">{pk(ctx, s.description_ar, s.description_en)}</p> : null}
          <p className="flex items-center gap-3 text-sm">
            {props.show_price !== false ? <span className="font-semibold">{priceLabel(ctx, s)}</span> : null}
            <span className="inline-flex items-center gap-1 text-sf-muted"><Clock className="size-3.5" aria-hidden />{formatDuration(s.duration_min, ctx.locale)}</span>
          </p>
          <div><BookButton ctx={ctx} serviceId={s.id} size="md" /></div>
        </div>
      </div>
    </Section>
  );
}

export function CategoriesBlock({ ctx, block, props }: BlockProps) {
  const kind = props.kind === 'product' ? 'product' : 'service';
  if (kind === 'product' && !ctx.data.features.products) return null;
  const items = ctx.data.catalog[kind === 'product' ? 'products' : 'services'] as Array<{ category_id: string | null }>;
  const cats = ctx.data.catalog.categories.filter((c) => c.kind === kind && items.some((i) => i.category_id === c.id));
  if (!cats.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_categories')} /></Section> : null;
  const href = (id: string) => (kind === 'product' ? hrefProducts(ctx, id) : hrefServices(ctx, id));
  return (
    <Section id={block.id} title={L(ctx, props.title) || undefined}>
      {props.display === 'tiles' ? (
        <ul className={cx('grid gap-3', cols(4))}>
          {cats.map((c) => <li key={c.id}><a href={href(c.id)} className={cx(cardClass(ctx.data.brand), 'flex min-h-20 items-center justify-center p-4 text-center font-semibold hover:brightness-[0.98]')}>{pk(ctx, c.name_ar, c.name_en)}</a></li>)}
        </ul>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {cats.map((c) => <li key={c.id}><a href={href(c.id)} className="inline-flex min-h-10 items-center rounded-full border border-sf-border bg-sf-surface px-4 text-sm hover:border-sf-primary">{pk(ctx, c.name_ar, c.name_en)}</a></li>)}
        </ul>
      )}
    </Section>
  );
}

export function ProductCard({ ctx, p, display, showPrice = true }: { ctx: RenderCtx; p: PublicProduct; display: 'grid' | 'list'; showPrice?: boolean }) {
  const name = pk(ctx, p.name_ar, p.name_en);
  const cart = p.default_variant_id && p.in_stock ? hrefCart(ctx, p.default_variant_id) : null;
  const img = p.image_asset_ids.find((id) => ctx.data.assets[id]);
  return (
    <li className={cx(cardClass(ctx.data.brand), 'flex overflow-hidden', display === 'list' ? 'flex-row items-center gap-3 p-3' : 'flex-col')}>
      <a href={hrefProduct(ctx, p.id)} className={cx(display === 'list' ? 'w-20 shrink-0' : '')} tabIndex={-1} aria-hidden>
        <SfImage ctx={ctx} id={img} alt="" aspect="1:1" rounded={display === 'list'} keepSpace />
      </a>
      <div className={cx('flex flex-1 flex-col gap-1', display === 'grid' && 'p-4')}>
        <h3 className="font-semibold"><a href={hrefProduct(ctx, p.id)} className="hover:underline">{name}</a></h3>
        {showPrice && p.price_minor != null ? <p className="text-sm font-medium">{money(ctx, p.price_minor)}</p> : null}
        {!p.in_stock ? <p className="text-xs text-sf-muted">{tr(ctx, 'out_of_stock')}</p> : null}
        {cart ? <a href={cart} className={cx(btnClass(ctx.data.brand, 'outline', 'sm'), 'mt-2 self-start')}><ShoppingBag className="size-4" aria-hidden />{tr(ctx, 'add_to_cart')}</a> : null}
      </div>
    </li>
  );
}

export function selectProducts(ctx: RenderCtx, props: { product_ids?: string[]; category_id?: string | null }) {
  const all = ctx.data.catalog.products;
  if (props.product_ids?.length) return props.product_ids.map((id) => all.find((s) => s.id === id)).filter((s): s is PublicProduct => !!s);
  if (props.category_id) return all.filter((s) => s.category_id === props.category_id);
  return all;
}

export function ProductGridBlock({ ctx, block, props }: BlockProps) {
  if (!ctx.data.features.products) return null;
  const list = selectProducts(ctx, props);
  if (!list.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_products')} /></Section> : null;
  const display = props.display === 'list' ? 'list' : 'grid';
  return (
    <Section id={block.id} title={L(ctx, props.title) || undefined}>
      <ul className={cx('grid gap-4', display === 'list' ? 'grid-cols-1 @2xl:grid-cols-2' : cols(props.columns ?? 3))}>
        {list.map((p) => <ProductCard key={p.id} ctx={ctx} p={p} display={display} showPrice={props.show_prices !== false} />)}
      </ul>
    </Section>
  );
}

export function ProductFeatureBlock({ ctx, block, props }: BlockProps) {
  if (!ctx.data.features.products) return null;
  const p = productById(ctx, props.product_id);
  if (!p) return <Section id={block.id}><Unavailable ctx={ctx} href={hrefProducts(ctx)} label={tr(ctx, 'product_unavailable')} /></Section>;
  const name = pk(ctx, p.name_ar, p.name_en);
  const img = p.image_asset_ids.find((id) => ctx.data.assets[id]);
  const cart = p.default_variant_id && p.in_stock ? hrefCart(ctx, p.default_variant_id) : null;
  return (
    <Section id={block.id}>
      <div className={cx(cardClass(ctx.data.brand), 'grid overflow-hidden', props.layout !== 'stacked' && '@3xl:grid-cols-2')}>
        <div className={cx(props.layout === 'image_end' && '@3xl:order-2')}><SfImage ctx={ctx} id={img} alt={name} aspect="1:1" rounded={false} keepSpace /></div>
        <div className="flex flex-col justify-center gap-3 p-6">
          <h3 className={cx(headingClass, 'text-2xl font-semibold')}><a href={hrefProduct(ctx, p.id)} className="hover:underline">{name}</a></h3>
          {pk(ctx, p.description_ar, p.description_en) ? <p className="line-clamp-4 text-sf-muted">{pk(ctx, p.description_ar, p.description_en)}</p> : null}
          {p.price_minor != null ? <p className="font-semibold">{money(ctx, p.price_minor)}</p> : null}
          {cart ? <a href={cart} className={cx(btnClass(ctx.data.brand, 'primary', 'md'), 'self-start')}><ShoppingBag className="size-4" aria-hidden />{tr(ctx, 'add_to_cart')}</a>
            : !p.in_stock ? <p className="text-sm text-sf-muted">{tr(ctx, 'out_of_stock')}</p> : null}
        </div>
      </div>
    </Section>
  );
}

export function OffersBlock({ ctx, block, props }: BlockProps) {
  const all = ctx.data.catalog.packages;
  const list = props.package_ids?.length ? (props.package_ids as string[]).map((id) => all.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p) : all;
  if (!list.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_offers')} /></Section> : null;
  return (
    <Section id={block.id} title={L(ctx, props.title) || undefined}>
      <ul className={cx('grid gap-4', props.display === 'list' ? 'grid-cols-1' : cols(3))}>
        {list.map((p) => (
          <li key={p.id} className={cx(cardClass(ctx.data.brand), 'flex flex-col gap-2 p-5')}>
            <h3 className={cx(headingClass, 'text-lg font-semibold')}>{pk(ctx, p.name_ar, p.name_en)}</h3>
            {pk(ctx, p.description_ar, p.description_en) ? <p className="text-sm text-sf-muted">{pk(ctx, p.description_ar, p.description_en)}</p> : null}
            {p.service_ids.length ? <ul className="list-disc ps-5 text-sm">{p.service_ids.map((id) => { const s = serviceById(ctx, id); return s ? <li key={id}>{pk(ctx, s.name_ar, s.name_en)}</li> : null; })}</ul> : null}
            <p className="mt-auto pt-2 text-lg font-semibold">{money(ctx, p.price_minor)}</p>
            <BookButton ctx={ctx} serviceId={p.service_ids[0] ?? null} label={tr(ctx, 'book_package')} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function StaffCard({ ctx, s, display, showBio }: { ctx: RenderCtx; s: PublicStaff; display: 'cards' | 'avatars'; showBio: boolean }) {
  const name = pk(ctx, s.display_name, s.display_name_en);
  const title = pk(ctx, s.title_ar, s.title_en);
  const photo = s.photo_asset_id && ctx.data.assets[s.photo_asset_id] ? s.photo_asset_id : null;
  if (display === 'avatars') {
    return (
      <li className="flex flex-col items-center gap-2 text-center">
        <a href={hrefStaff(ctx, s.id)} className="flex flex-col items-center gap-2">
          {photo ? <div className="size-24 overflow-hidden rounded-full"><SfImage ctx={ctx} id={photo} alt={name} aspect="1:1" rounded={false} /></div>
            : <span className="flex size-24 items-center justify-center rounded-full bg-sf-secondary/20"><UserRound className="size-10 text-sf-muted" aria-hidden /></span>}
          <span className="font-semibold">{name}</span>
        </a>
        {title ? <span className="text-sm text-sf-muted">{title}</span> : null}
      </li>
    );
  }
  const bio = pk(ctx, s.bio_ar, s.bio_en);
  return (
    <li className={cx(cardClass(ctx.data.brand), 'flex flex-col overflow-hidden')}>
      {photo ? <SfImage ctx={ctx} id={photo} alt={name} aspect="3:4" rounded={false} /> : <div className="flex aspect-[3/4] items-center justify-center bg-sf-secondary/15"><UserRound className="size-12 text-sf-muted" aria-hidden /></div>}
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className={cx(headingClass, 'text-lg font-semibold')}><a href={hrefStaff(ctx, s.id)} className="hover:underline">{name}</a></h3>
        {title ? <p className="text-sm text-sf-muted">{title}</p> : null}
        {showBio && bio ? <p className="line-clamp-3 text-sm">{bio}</p> : null}
        <div className="mt-auto flex flex-wrap gap-2 pt-3">
          <BookButton ctx={ctx} staffId={s.id} label={tr(ctx, 'book_with', { name })} />
        </div>
      </div>
    </li>
  );
}

export function TeamBlock({ ctx, block, props }: BlockProps) {
  const all = ctx.data.catalog.staff;
  const list = props.staff_ids?.length ? (props.staff_ids as string[]).map((id) => all.find((s) => s.id === id)).filter((s): s is PublicStaff => !!s) : all;
  if (!list.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_team')} /></Section> : null;
  const display = props.display === 'avatars' ? 'avatars' : 'cards';
  return (
    <Section id={block.id} title={L(ctx, props.title) || undefined}>
      <ul className={cx('grid gap-4', display === 'avatars' ? 'grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-5' : cols(3))}>
        {list.map((s) => <StaffCard key={s.id} ctx={ctx} s={s} display={display} showBio={props.show_bios !== false} />)}
      </ul>
    </Section>
  );
}

export function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span className="inline-flex text-sf-accent" role="img" aria-label={label}>
      {Array.from({ length: 5 }, (_, i) => <Star key={i} className={cx('size-4', i < rating ? 'fill-current' : 'opacity-30')} aria-hidden />)}
    </span>
  );
}

export function ReviewsBlock({ ctx, block, props }: BlockProps) {
  // Only real, visit-linked, published reviews — never invented testimonials.
  const list = ctx.data.catalog.reviews.filter((r) => r.rating >= (props.min_rating ?? 4)).slice(0, props.limit ?? 6);
  if (!list.length) return ctx.canvas ? <Section id={block.id} title={L(ctx, props.title) || undefined}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_reviews')} /></Section> : null;
  return (
    <Section id={block.id} title={L(ctx, props.title) || tr(ctx, 'reviews')}>
      <ul className={cx('grid gap-4', cols(3))}>
        {list.map((r) => {
          const staff = props.show_staff !== false && r.staff_id ? ctx.data.catalog.staff.find((s) => s.id === r.staff_id) : null;
          return (
            <li key={r.id} className={cx(cardClass(ctx.data.brand), 'flex flex-col gap-2 p-5')}>
              <Stars rating={r.rating} label={tr(ctx, 'rating', { n: r.rating })} />
              {r.comment ? <blockquote className="text-sm leading-relaxed">“{r.comment}”</blockquote> : null}
              <p className="mt-auto text-xs text-sf-muted">{r.author}{staff ? ` · ${tr(ctx, 'with_staff', { name: pk(ctx, staff.display_name, staff.display_name_en) })}` : ''}</p>
              {r.business_reply ? <p className="rounded-sf bg-sf-secondary/10 p-2 text-xs">{r.business_reply}</p> : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
