import { ArrowRight, Clock, ShieldCheck, ShoppingBag, UserRound } from 'lucide-react';
import { cx } from '../components/cx';
import { makeBlock, type PageBlock } from '@/shared/builder/blocks';
import type { SnapshotPage } from '@/shared/builder/storefront';
import { formatDuration, formatMoney } from '@/shared/format';
import { RenderBlocks } from './BlockRenderer';
import { SfImage } from './SfImage';
import { btnClass, cardClass, containerClass, headingClass, sectionClass } from './theme';
import { hrefCart, hrefPage, hrefProducts, hrefService, hrefServices, hrefStaff, money, pageByKind, pk, tr, type RenderCtx } from './context';
import { BookButton, priceLabel, ProductCard, ServiceGrid, StaffCard } from './blocks/catalog';
import { ContactList, HoursTable, MapBlock } from './blocks/info';
import { Section } from './blocks/common';

export function PageTitle({ ctx, title, subtitle }: { ctx: RenderCtx; title: string; subtitle?: string }) {
  return (
    <div className={cx(sectionClass, '!pb-0')}>
      <div className={containerClass}>
        <h1 className={cx(headingClass, 'text-3xl font-bold @2xl:text-4xl')}>{title}</h1>
        {subtitle ? <p className="mt-2 text-sf-muted">{subtitle}</p> : null}
      </div>
    </div>
  );
}

const visible = (blocks: PageBlock[]) => blocks.filter((b) => b.visibility.enabled);

/** Default content for LUMA's fixed pages when the owner has not added blocks yet. */
function defaults(ctx: RenderCtx, page: SnapshotPage): PageBlock[] {
  switch (page.kind) {
    case 'home': return [makeBlock('hero', { id: 'default_hero', props: { ...makeBlock('hero').props, title: { ar: ctx.data.tenant.name, en: ctx.data.tenant.name } } }), makeBlock('service_list', { id: 'default_services' }), makeBlock('contact', { id: 'default_contact' })];
    case 'services': return [makeBlock('categories', { id: 'default_cats' }), makeBlock('service_list', { id: 'default_services', props: { ...makeBlock('service_list').props, display: ctx.data.layout.service_display, group_by_category: true } })];
    case 'products': return [makeBlock('categories', { id: 'default_cats', props: { kind: 'product', display: 'chips' } }), makeBlock('product_grid', { id: 'default_products', props: { ...makeBlock('product_grid').props, display: ctx.data.layout.product_display } })];
    case 'team': return [makeBlock('team', { id: 'default_team' })];
    case 'contact': return [makeBlock('contact', { id: 'default_contact' }), makeBlock('hours', { id: 'default_hours' }), makeBlock('map', { id: 'default_map' })];
    case 'about': return [makeBlock('hours', { id: 'default_hours' })];
    default: return [];
  }
}

/** Booking & payment terms, always reachable before paying (live settings, not design). */
export function BookingPolicySummary({ ctx }: { ctx: RenderCtx }) {
  const p = ctx.data.policy;
  const text = pk(ctx, p.text_ar, p.text_en);
  const fee = p.late_cancellation_fee_bp ? `${p.late_cancellation_fee_bp / 100}%` : null;
  const deposit = p.deposit_mode === 'percent' ? `${p.deposit_percent_bp / 100}%` : p.deposit_mode === 'fixed' ? formatMoney(p.deposit_fixed_minor, ctx.data.tenant.currency, ctx.locale) : null;
  return (
    <Section id="booking-terms" title={tr(ctx, 'policy.title')}>
      <div className={cx(cardClass(ctx.data.brand), 'flex flex-col gap-3 p-5')}>
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sf-primary" aria-hidden />{tr(ctx, 'policy.free_cancellation', { hours: p.free_cancellation_hours })}</li>
          {fee ? <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sf-primary" aria-hidden />{tr(ctx, 'policy.late_fee', { fee })}</li> : null}
          <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sf-primary" aria-hidden />{deposit ? tr(ctx, 'policy.deposit', { amount: deposit }) : tr(ctx, 'policy.no_deposit')}</li>
          {p.allow_pay_on_site ? <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-sf-primary" aria-hidden />{tr(ctx, 'policy.pay_on_site')}</li> : null}
        </ul>
        {text ? <p className="whitespace-pre-line border-t border-sf-border pt-3 text-sm leading-relaxed">{text}</p> : null}
      </div>
    </Section>
  );
}

export function PageView({ ctx, page }: { ctx: RenderCtx; page: SnapshotPage }) {
  const own = visible(page.blocks);
  const blocks = own.length ? page.blocks : defaults(ctx, page);
  const startsWithHero = visible(blocks)[0]?.type === 'hero';
  const title = pk(ctx, page.title_ar, page.title_en);
  return (
    <>
      {page.kind === 'home'
        ? (!startsWithHero ? <h1 className="sr-only">{ctx.data.tenant.name}</h1> : null)
        : (!startsWithHero ? <PageTitle ctx={ctx} title={title} /> : null)}
      <RenderBlocks ctx={ctx} blocks={blocks} />
      {page.kind === 'booking_policy' ? <BookingPolicySummary ctx={ctx} /> : null}
      {!visible(blocks).length && page.kind !== 'booking_policy' ? <Section id="empty"><p className="text-sf-muted">{tr(ctx, 'page_empty')}</p></Section> : null}
    </>
  );
}

export function CategoryFilter({ ctx, kind, active }: { ctx: RenderCtx; kind: 'service' | 'product'; active?: string | null }) {
  const items = ctx.data.catalog[kind === 'product' ? 'products' : 'services'] as Array<{ category_id: string | null }>;
  const cats = ctx.data.catalog.categories.filter((c) => c.kind === kind && items.some((i) => i.category_id === c.id));
  if (!cats.length) return null;
  const href = (id?: string) => (kind === 'product' ? hrefProducts(ctx, id) : hrefServices(ctx, id));
  const chip = (on: boolean) => cx('inline-flex min-h-10 items-center rounded-full border px-4 text-sm', on ? 'border-sf-primary bg-sf-primary text-sf-on-primary' : 'border-sf-border bg-sf-surface hover:border-sf-primary');
  return (
    <nav aria-label={tr(ctx, 'categories')} className="mb-5">
      <ul className="flex flex-wrap gap-2">
        <li><a href={href()} className={chip(!active)} aria-current={!active ? 'page' : undefined}>{tr(ctx, 'all')}</a></li>
        {cats.map((c) => <li key={c.id}><a href={href(c.id)} className={chip(active === c.id)} aria-current={active === c.id ? 'page' : undefined}>{pk(ctx, c.name_ar, c.name_en)}</a></li>)}
      </ul>
    </nav>
  );
}

export function ServicesIndex({ ctx, categoryId }: { ctx: RenderCtx; categoryId: string }) {
  const cat = ctx.data.catalog.categories.find((c) => c.id === categoryId && c.kind === 'service');
  const list = ctx.data.catalog.services.filter((s) => s.category_id === categoryId);
  const page = pageByKind(ctx, 'services');
  return (
    <>
      <PageTitle ctx={ctx} title={cat ? pk(ctx, cat.name_ar, cat.name_en) : pk(ctx, page?.title_ar, page?.title_en) || tr(ctx, 'services')} />
      <Section id="services-list">
        <CategoryFilter ctx={ctx} kind="service" active={categoryId} />
        {list.length ? <ServiceGrid ctx={ctx} services={list} display={ctx.data.layout.service_display} columns={2} showPrice showDuration />
          : <p className="text-sf-muted">{tr(ctx, 'category_empty')} <a className="text-sf-primary underline" href={hrefServices(ctx)}>{tr(ctx, 'see_all')}</a></p>}
      </Section>
    </>
  );
}

export function ProductsIndex({ ctx, categoryId }: { ctx: RenderCtx; categoryId: string }) {
  const cat = ctx.data.catalog.categories.find((c) => c.id === categoryId && c.kind === 'product');
  const list = ctx.data.catalog.products.filter((p) => p.category_id === categoryId);
  return (
    <>
      <PageTitle ctx={ctx} title={cat ? pk(ctx, cat.name_ar, cat.name_en) : tr(ctx, 'products')} />
      <Section id="products-list">
        <CategoryFilter ctx={ctx} kind="product" active={categoryId} />
        {list.length ? <ul className="grid grid-cols-2 gap-4 @5xl:grid-cols-3">{list.map((p) => <ProductCard key={p.id} ctx={ctx} p={p} display="grid" />)}</ul>
          : <p className="text-sf-muted">{tr(ctx, 'category_empty')} <a className="text-sf-primary underline" href={hrefProducts(ctx)}>{tr(ctx, 'see_all')}</a></p>}
      </Section>
    </>
  );
}

export function ServiceDetail({ ctx, id }: { ctx: RenderCtx; id: string }) {
  const s = ctx.data.catalog.services.find((x) => x.id === id)!;
  const name = pk(ctx, s.name_ar, s.name_en);
  const staff = s.staff_ids.map((sid) => ctx.data.catalog.staff.find((x) => x.id === sid)).filter((x): x is NonNullable<typeof x> => !!x);
  const cat = s.category_id ? ctx.data.catalog.categories.find((c) => c.id === s.category_id) : null;
  return (
    <article>
      <div className={sectionClass}>
        <div className={cx(containerClass, 'grid gap-8', s.image_asset_id && ctx.data.assets[s.image_asset_id] && '@3xl:grid-cols-2')}>
          {s.image_asset_id && ctx.data.assets[s.image_asset_id] ? <SfImage ctx={ctx} id={s.image_asset_id} alt={name} aspect="4:3" eager /> : null}
          <div className="flex flex-col gap-4">
            {cat ? <a href={hrefServices(ctx, cat.id)} className="text-sm text-sf-primary hover:underline">{pk(ctx, cat.name_ar, cat.name_en)}</a> : null}
            <h1 className={cx(headingClass, 'text-3xl font-bold @2xl:text-4xl')}>{name}</h1>
            <p className="flex flex-wrap items-center gap-4">
              <span className="text-xl font-semibold">{priceLabel(ctx, s)}</span>
              <span className="inline-flex items-center gap-1 text-sf-muted"><Clock className="size-4" aria-hidden />{formatDuration(s.duration_min, ctx.locale)}</span>
            </p>
            {pk(ctx, s.description_ar, s.description_en) ? <p className="whitespace-pre-line leading-relaxed">{pk(ctx, s.description_ar, s.description_en)}</p> : null}
            <div><BookButton ctx={ctx} serviceId={s.id} size="lg" label={tr(ctx, 'book_this')} /></div>
            {!s.bookable ? <p className="text-sm text-sf-muted">{tr(ctx, 'not_bookable_online')}</p> : null}
            <p className="text-xs text-sf-muted">{tr(ctx, 'price_note')} <a className="underline" href={hrefPage(ctx, pageByKind(ctx, 'booking_policy') ?? { kind: 'booking_policy', slug: 'booking-policy' })}>{tr(ctx, 'policy.title')}</a></p>
          </div>
        </div>
      </div>
      {staff.length ? (
        <Section id="service-staff" title={tr(ctx, 'specialists')}>
          <ul className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {staff.map((st) => (
              <li key={st.id} className={cx(cardClass(ctx.data.brand), 'flex items-center gap-3 p-3')}>
                {st.photo_asset_id && ctx.data.assets[st.photo_asset_id] ? <div className="size-14 shrink-0 overflow-hidden rounded-full"><SfImage ctx={ctx} id={st.photo_asset_id} alt="" aspect="1:1" rounded={false} /></div>
                  : <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-sf-secondary/20"><UserRound className="size-6 text-sf-muted" aria-hidden /></span>}
                <div className="min-w-0 flex-1">
                  <a href={hrefStaff(ctx, st.id)} className="font-semibold hover:underline">{pk(ctx, st.display_name, st.display_name_en)}</a>
                  {pk(ctx, st.title_ar, st.title_en) ? <p className="text-xs text-sf-muted">{pk(ctx, st.title_ar, st.title_en)}</p> : null}
                </div>
                <BookButton ctx={ctx} serviceId={s.id} staffId={st.id} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}

export function StaffProfile({ ctx, id }: { ctx: RenderCtx; id: string }) {
  const s = ctx.data.catalog.staff.find((x) => x.id === id)!;
  const name = pk(ctx, s.display_name, s.display_name_en);
  const services = s.service_ids.map((sid) => ctx.data.catalog.services.find((x) => x.id === sid)).filter((x): x is NonNullable<typeof x> => !!x);
  const reviews = ctx.data.catalog.reviews.filter((r) => r.staff_id === s.id).slice(0, 6);
  return (
    <article>
      <div className={sectionClass}>
        <div className={cx(containerClass, 'grid gap-8 @3xl:grid-cols-[minmax(0,280px)_1fr]')}>
          {s.photo_asset_id && ctx.data.assets[s.photo_asset_id] ? <SfImage ctx={ctx} id={s.photo_asset_id} alt={name} aspect="3:4" eager />
            : <div className="flex aspect-[3/4] items-center justify-center rounded-sf bg-sf-secondary/15"><UserRound className="size-16 text-sf-muted" aria-hidden /></div>}
          <div className="flex flex-col gap-3">
            <h1 className={cx(headingClass, 'text-3xl font-bold')}>{name}</h1>
            {pk(ctx, s.title_ar, s.title_en) ? <p className="text-sf-muted">{pk(ctx, s.title_ar, s.title_en)}</p> : null}
            {pk(ctx, s.bio_ar, s.bio_en) ? <p className="whitespace-pre-line leading-relaxed">{pk(ctx, s.bio_ar, s.bio_en)}</p> : null}
            {/* Preselects this specialist in the booking flow: /s/{slug}/booking?staff={id} */}
            <div><BookButton ctx={ctx} staffId={s.id} size="lg" label={tr(ctx, 'book_with', { name })} /></div>
          </div>
        </div>
      </div>
      {services.length ? <Section id="staff-services" title={tr(ctx, 'services_by', { name })}><ServiceGrid ctx={ctx} services={services} display="list" columns={1} showPrice showDuration /></Section> : null}
      {reviews.length ? (
        <Section id="staff-reviews" title={tr(ctx, 'reviews')}>
          <ul className="grid gap-3 @2xl:grid-cols-2">{reviews.map((r) => <li key={r.id} className={cx(cardClass(ctx.data.brand), 'p-4 text-sm')}><p>“{r.comment ?? '★'.repeat(r.rating)}”</p><p className="mt-2 text-xs text-sf-muted">{r.author}</p></li>)}</ul>
        </Section>
      ) : null}
    </article>
  );
}

export function ProductDetail({ ctx, id }: { ctx: RenderCtx; id: string }) {
  const p = ctx.data.catalog.products.find((x) => x.id === id)!;
  const name = pk(ctx, p.name_ar, p.name_en);
  const imgs = p.image_asset_ids.filter((a) => ctx.data.assets[a]);
  const cart = p.default_variant_id && p.in_stock ? hrefCart(ctx, p.default_variant_id) : null;
  return (
    <article className={sectionClass}>
      <div className={cx(containerClass, 'grid gap-8 @3xl:grid-cols-2')}>
        <div className="flex flex-col gap-3">
          <SfImage ctx={ctx} id={imgs[0]} alt={name} aspect="1:1" eager keepSpace />
          {imgs.length > 1 ? <ul className="grid grid-cols-4 gap-2">{imgs.slice(1, 9).map((a) => <li key={a}><SfImage ctx={ctx} id={a} alt="" aspect="1:1" /></li>)}</ul> : null}
        </div>
        <div className="flex flex-col gap-4">
          <h1 className={cx(headingClass, 'text-3xl font-bold')}>{name}</h1>
          {p.price_minor != null ? <p className="text-xl font-semibold">{money(ctx, p.price_minor)}</p> : null}
          {pk(ctx, p.description_ar, p.description_en) ? <p className="whitespace-pre-line leading-relaxed">{pk(ctx, p.description_ar, p.description_en)}</p> : null}
          {p.variants.length > 1 ? (
            <ul className="flex flex-col gap-2" aria-label={tr(ctx, 'options')}>
              {p.variants.map((v) => {
                const href = v.in_stock ? hrefCart(ctx, v.id) : null;
                return (
                  <li key={v.id} className={cx(cardClass(ctx.data.brand), 'flex items-center justify-between gap-3 p-3 text-sm')}>
                    <span>{pk(ctx, v.name_ar, v.name_en) || name} · <strong>{money(ctx, v.price_minor)}</strong></span>
                    {href ? <a href={href} className={btnClass(ctx.data.brand, 'outline', 'sm')}><ShoppingBag className="size-4" aria-hidden />{tr(ctx, 'add_to_cart')}</a> : <span className="text-sf-muted">{v.in_stock ? '' : tr(ctx, 'out_of_stock')}</span>}
                  </li>
                );
              })}
            </ul>
          ) : cart ? <div><a href={cart} className={btnClass(ctx.data.brand, 'primary', 'lg')}><ShoppingBag className="size-5" aria-hidden />{tr(ctx, 'add_to_cart')}</a></div>
            : <p className="text-sf-muted">{p.in_stock ? tr(ctx, 'preview_cart_disabled') : tr(ctx, 'out_of_stock')}</p>}
          <a href={hrefProducts(ctx)} className="inline-flex items-center gap-1 text-sm text-sf-primary hover:underline">{tr(ctx, 'all_products')}<ArrowRight className="size-4 flip-rtl" aria-hidden /></a>
        </div>
      </div>
    </article>
  );
}

export function TeamIndex({ ctx }: { ctx: RenderCtx }) {
  return (
    <ul className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {ctx.data.catalog.staff.map((s) => <StaffCard key={s.id} ctx={ctx} s={s} display="cards" showBio />)}
    </ul>
  );
}

export function ContactView({ ctx }: { ctx: RenderCtx }) {
  const primary = ctx.data.branches.find((b) => b.is_primary) ?? ctx.data.branches[0];
  const address = [primary?.address, primary?.city].filter(Boolean).join('، ');
  return (
    <div className="grid gap-6 @3xl:grid-cols-2">
      <ContactList ctx={ctx} c={ctx.data.contact} address={address} />
      {primary?.hours.length ? <HoursTable ctx={ctx} branch={primary} /> : null}
      <div className="@3xl:col-span-2"><MapBlock ctx={ctx} block={makeBlock('map', { id: 'contact_map' })} props={{ zoom: 15, branch_id: null }} pageBlocks={[]} /></div>
    </div>
  );
}

export function PoliciesView({ ctx }: { ctx: RenderCtx }) {
  const pages = ctx.data.pages.filter((p) => ['booking_policy', 'privacy', 'returns', 'faq'].includes(p.kind) || (p.kind === 'custom' && p.show_in_footer));
  return (
    <>
      <PageTitle ctx={ctx} title={tr(ctx, 'policies')} />
      <BookingPolicySummary ctx={ctx} />
      <Section id="policy-pages">
        <ul className="flex flex-col gap-2">
          {pages.map((p) => (
            <li key={p.id}><a href={hrefPage(ctx, p)} className={cx(cardClass(ctx.data.brand), 'flex items-center justify-between p-4 hover:brightness-[0.98]')}>
              <span className="font-medium">{pk(ctx, p.title_ar, p.title_en)}</span><ArrowRight className="size-4 flip-rtl" aria-hidden />
            </a></li>
          ))}
        </ul>
      </Section>
    </>
  );
}

export function StorefrontNotFound({ ctx }: { ctx: RenderCtx }) {
  return (
    <Section id="not-found">
      <h1 className={cx(headingClass, 'text-2xl font-semibold')}>{tr(ctx, 'not_found')}</h1>
      <p className="mt-2 text-sf-muted">{tr(ctx, 'not_found_hint')}</p>
      <a className={cx(btnClass(ctx.data.brand, 'primary'), 'mt-4')} href={hrefServices(ctx)}>{tr(ctx, 'services')}</a>
    </Section>
  );
}

export { hrefService };
