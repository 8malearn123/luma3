import type { ReactNode } from 'react';
import { CalendarCheck, Home, Phone, ShoppingBag, Sparkles, Users } from 'lucide-react';
import { cx } from '../components/cx';
import { dir } from '@/i18n';
import { SfImage } from './SfImage';
import { btnClass, containerClass, headingClass, themeStyle } from './theme';
import { hrefBooking, hrefHome, hrefPage, hrefPolicies, pageByKind, pk, tr, type RenderCtx } from './context';
import { HoursTable, SocialLinks } from './blocks/info';
import { LocaleSwitch } from './LocaleSwitch';

/** Which booking entries are shown. At least one is ALWAYS present: removing display blocks never removes booking. */
export function bookingEntries(ctx: RenderCtx) {
  const l = ctx.data.layout;
  const header = l.header.show_book_button && l.booking_entry !== 'floating';
  const floating = l.nav_style !== 'bottom' && (l.booking_entry !== 'header' || !header);
  return { header, floating, bottomNav: l.nav_style === 'bottom' };
}

function navItems(ctx: RenderCtx) {
  return ctx.data.pages.filter((p) => p.show_in_nav && p.kind !== 'home' && (p.kind !== 'products' || ctx.data.features.products))
    .sort((a, b) => a.sort - b.sort)
    .map((p) => ({ id: p.id, label: pk(ctx, p.title_ar, p.title_en), href: hrefPage(ctx, p), kind: p.kind }));
}

function BookLink({ ctx, className, children }: { ctx: RenderCtx; className: string; children: ReactNode }) {
  const href = hrefBooking(ctx);
  if (!href) return <span className={cx(className, 'opacity-70')} aria-disabled title={tr(ctx, 'preview_booking_disabled')}>{children}</span>;
  return <a href={href} className={className}>{children}</a>;
}

export function StorefrontShell({ ctx, children, activePath }: { ctx: RenderCtx; children: ReactNode; activePath?: string }) {
  const { data } = ctx;
  const b = data.brand;
  const l = data.layout;
  const nav = navItems(ctx);
  const entries = bookingEntries(ctx);
  const name = data.tenant.name;
  const logo = l.header.show_logo && b.logo_asset_id && data.assets[b.logo_asset_id] ? b.logo_asset_id : null;
  const brandName = b.wordmark_text || name;
  const footerPages = data.pages.filter((p) => p.show_in_footer).sort((a, c) => a.sort - c.sort);
  const primary = data.branches.find((x) => x.is_primary) ?? data.branches[0];
  const navLink = (active: boolean) => l.nav_style === 'pill'
    ? cx('inline-flex min-h-9 items-center whitespace-nowrap rounded-full px-4 text-sm', active ? 'bg-sf-primary text-sf-on-primary' : 'bg-sf-surface border border-sf-border hover:border-sf-primary')
    : cx('inline-flex min-h-9 items-center whitespace-nowrap px-2 text-sm underline-offset-8 hover:underline', active && 'font-semibold underline decoration-2 decoration-sf-primary');

  const bottomIcon = (kind: string) => (kind === 'services' ? Sparkles : kind === 'products' ? ShoppingBag : kind === 'team' ? Users : kind === 'contact' ? Phone : Sparkles);

  return (
    <div dir={dir(ctx.locale)} lang={ctx.locale} style={themeStyle(b)}
      className={cx('storefront relative flex min-h-full flex-col bg-sf-bg font-sf-body text-sf-text', !ctx.canvas && 'min-h-dvh', entries.bottomNav && (ctx.canvas ? ctx.device === 'mobile' && 'pb-16' : 'pb-20 md:pb-0'))}>
      {/* Query container: blocks adapt to the storefront's width (also inside the builder's mobile preview). */}
      <div className="@container flex flex-1 flex-col">
      <a href="#sf-main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-sf-surface focus:p-2">{tr(ctx, 'skip')}</a>
      {data.mode === 'preview' ? <div className="bg-amber-100 px-4 py-1.5 text-center text-xs text-amber-900" role="status">{tr(ctx, 'preview_banner')}</div> : null}
      <header className={cx('z-30 border-b border-sf-border bg-sf-bg/95 backdrop-blur', l.header.sticky && 'sticky top-0')}>
        <div className={cx(containerClass, 'flex items-center gap-3 px-4 py-3 @2xl:px-6')}>
          <a href={hrefHome(ctx)} className="flex min-w-0 items-center gap-2" aria-label={tr(ctx, 'home_of', { name })}>
            {logo ? <span className="block h-10 w-auto max-w-[120px]"><SfImage ctx={ctx} id={logo} alt={name} aspect="auto" rounded={false} eager className="!h-10 !w-auto object-contain" /></span> : null}
            {l.header.show_name || !logo ? <span className={cx(headingClass, 'truncate text-lg font-semibold')}>{brandName}</span> : null}
          </a>
          <nav aria-label={tr(ctx, 'main_nav')} className="ms-auto hidden min-w-0 @3xl:block">
            <ul className="flex items-center gap-1">
              {nav.map((n) => <li key={n.id}><a href={n.href} className={navLink(activePath === n.kind)} aria-current={activePath === n.kind ? 'page' : undefined}>{n.label}</a></li>)}
            </ul>
          </nav>
          <div className="ms-auto flex items-center gap-2 @3xl:ms-0">
            <LocaleSwitch locale={ctx.locale} disabled={!!ctx.canvas} />
            {entries.header ? <BookLink ctx={ctx} className={btnClass(b, 'primary', 'sm')}><CalendarCheck className="size-4" aria-hidden />{tr(ctx, 'book_now')}</BookLink> : null}
          </div>
        </div>
        {!entries.bottomNav && nav.length ? (
          <nav aria-label={tr(ctx, 'main_nav')} className="border-t border-sf-border @3xl:hidden">
            <ul className="flex gap-1 overflow-x-auto px-3 py-2">
              {nav.map((n) => <li key={n.id}><a href={n.href} className={navLink(activePath === n.kind)}>{n.label}</a></li>)}
            </ul>
          </nav>
        ) : null}
      </header>

      <main id="sf-main" className="flex-1">{children}</main>

      <footer className="mt-8 border-t border-sf-border bg-sf-surface">
        <div className={cx(containerClass, 'grid gap-8 px-4 py-10 @2xl:px-6 @3xl:grid-cols-3')}>
          <div className="flex flex-col gap-3">
            <p className={cx(headingClass, 'text-lg font-semibold')}>{brandName}</p>
            {pk(ctx, b.tagline_ar, b.tagline_en) ? <p className="text-sm text-sf-muted">{pk(ctx, b.tagline_ar, b.tagline_en)}</p> : null}
            {l.footer.show_social ? <SocialLinks ctx={ctx} style="icons" /> : null}
          </div>
          {l.footer.show_hours && primary?.hours.length ? <div><p className="mb-2 font-semibold">{tr(ctx, 'opening_hours')}</p><HoursTable ctx={ctx} branch={primary} /></div> : <div />}
          {l.footer.show_policies ? (
            <nav aria-label={tr(ctx, 'footer_nav')}>
              <p className="mb-2 font-semibold">{tr(ctx, 'information')}</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {footerPages.map((p) => <li key={p.id}><a className="hover:underline" href={hrefPage(ctx, p)}>{pk(ctx, p.title_ar, p.title_en)}</a></li>)}
                <li><a className="hover:underline" href={hrefPolicies(ctx)}>{tr(ctx, 'all_policies')}</a></li>
              </ul>
            </nav>
          ) : null}
        </div>
        <div className="border-t border-sf-border px-4 py-4 text-center text-xs text-sf-muted">
          <p>© {name}</p>
          {data.powered_by ? (
            <p className="mt-1">
              <a href="/" target="_blank" rel="noopener" className="inline-flex items-center gap-1 hover:underline">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/luma-mark.svg" alt="" width={14} height={14} className="size-3.5" />
                {tr(ctx, 'powered_by')}
              </a>
            </p>
          ) : null}
        </div>
      </footer>
      </div>

      {entries.floating ? (
        <div className={cx('pointer-events-none z-40 flex justify-end px-4', ctx.canvas ? 'sticky bottom-4' : 'fixed inset-x-0 bottom-4')}>
          <BookLink ctx={ctx} className={cx(btnClass(b, 'primary', 'lg'), 'pointer-events-auto shadow-lg')}><CalendarCheck className="size-5" aria-hidden />{tr(ctx, 'book_now')}</BookLink>
        </div>
      ) : null}

      {entries.bottomNav ? (
        <nav aria-label={tr(ctx, 'main_nav')} className={cx('z-40 border-t border-sf-border bg-sf-surface', ctx.canvas ? (ctx.device === 'mobile' ? 'sticky bottom-0' : 'hidden') : 'fixed inset-x-0 bottom-0 md:hidden')}>
          <ul className="grid grid-cols-5">
            <li><a href={hrefHome(ctx)} className="flex flex-col items-center gap-0.5 py-2 text-[11px]"><Home className="size-5" aria-hidden />{tr(ctx, 'home')}</a></li>
            {nav.slice(0, 2).map((n) => { const I = bottomIcon(n.kind); return <li key={n.id}><a href={n.href} className="flex flex-col items-center gap-0.5 py-2 text-[11px]"><I className="size-5" aria-hidden /><span className="max-w-full truncate px-1">{n.label}</span></a></li>; })}
            <li className={cx(nav.length < 2 && 'col-start-4')}><BookLink ctx={ctx} className="flex flex-col items-center gap-0.5 py-2 text-[11px] font-semibold text-sf-primary"><CalendarCheck className="size-5" aria-hidden />{tr(ctx, 'book')}</BookLink></li>
            {pageByKind(ctx, 'contact') ? <li><a href={hrefPage(ctx, pageByKind(ctx, 'contact')!)} className="flex flex-col items-center gap-0.5 py-2 text-[11px]"><Phone className="size-5" aria-hidden />{tr(ctx, 'contact')}</a></li> : null}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
