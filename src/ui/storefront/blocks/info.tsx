import { AtSign, Camera, Ghost, Globe, Mail, MapPin, MessageCircle, Music2, Phone, PlayCircle, Users, type LucideIcon } from 'lucide-react';
import { cx } from '../../components/cx';
import type { PublicBranch, StorefrontData } from '@/shared/builder/storefront';
import { formatClock, tzLabel, WEEKDAYS } from '@/shared/format';
import { cardClass } from '../theme';
import { L, tr, type RenderCtx } from '../context';
import { CanvasEmpty, Section } from './common';
import type { BlockProps } from './media';

function branchFor(ctx: RenderCtx, id: string | null | undefined): PublicBranch | undefined {
  return (id ? ctx.data.branches.find((b) => b.id === id) : undefined) ?? ctx.data.branches.find((b) => b.is_primary) ?? ctx.data.branches[0];
}

export function osmEmbed(lat: number, lon: number, zoom: number) {
  const d = 0.02 * 2 ** (15 - zoom);
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lon - d},${lat - d / 2},${lon + d},${lat + d / 2}&layer=mapnik&marker=${lat},${lon}`;
}
export const osmLink = (lat: number, lon: number, zoom = 16) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`;
export const osmSearch = (q: string) => `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`;

export function MapBlock({ ctx, block, props }: BlockProps) {
  const b = branchFor(ctx, props.branch_id);
  const address = [b?.address, b?.city].filter(Boolean).join('، ');
  const title = L(ctx, props.title) || tr(ctx, 'find_us');
  if (!b || (b.latitude == null && !address)) return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_map')} /></Section> : null;
  return (
    <Section id={block.id} title={title}>
      {b.latitude != null && b.longitude != null ? (
        <div className="flex flex-col gap-2">
          <iframe title={tr(ctx, 'map_of', { name: b.name })} src={osmEmbed(b.latitude, b.longitude, props.zoom ?? 15)} loading="lazy" referrerPolicy="no-referrer"
            className={cx('h-72 w-full border-0', cardClass(ctx.data.brand))} sandbox="allow-scripts allow-same-origin" />
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {address ? <span className="inline-flex items-center gap-1"><MapPin className="size-4" aria-hidden />{address}</span> : null}
            <a href={osmLink(b.latitude, b.longitude)} target="_blank" rel="noopener noreferrer" className="text-sf-primary underline">{tr(ctx, 'open_map')}</a>
          </p>
        </div>
      ) : (
        <a href={osmSearch(address)} target="_blank" rel="noopener noreferrer" className={cx(cardClass(ctx.data.brand), 'inline-flex items-center gap-2 p-4 text-sf-primary underline')}>
          <MapPin className="size-5" aria-hidden />{address}
        </a>
      )}
    </Section>
  );
}

export function HoursTable({ ctx, branch }: { ctx: RenderCtx; branch: PublicBranch }) {
  const days = [0, 1, 2, 3, 4, 5, 6];
  return (
    <div className={cx(cardClass(ctx.data.brand), 'p-4')}>
      <table className="w-full text-sm">
        <caption className="mb-2 text-start text-xs text-sf-muted">{branch.name} · {tzLabel(branch.timezone, ctx.locale)}</caption>
        <tbody>
          {days.map((d) => {
            const r = branch.hours.filter((h) => h.weekday === d);
            return (
              <tr key={d} className="border-t border-sf-border first:border-t-0">
                <th scope="row" className="py-2 text-start font-medium">{WEEKDAYS[ctx.locale][d]}</th>
                <td className="py-2 text-end" dir="ltr">{r.length ? r.map((h) => `${formatClock(h.opens, ctx.locale)} – ${formatClock(h.closes, ctx.locale)}`).join(' · ') : <span className="text-sf-muted" dir="auto">{tr(ctx, 'closed')}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HoursBlock({ ctx, block, props }: BlockProps) {
  const b = branchFor(ctx, props.branch_id);
  const title = L(ctx, props.title) || tr(ctx, 'opening_hours');
  if (!b || !b.hours.length) return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_hours')} /></Section> : null;
  return <Section id={block.id} title={title}><div className="max-w-xl"><HoursTable ctx={ctx} branch={b} /></div></Section>;
}

export const waLink = (n: string) => `https://wa.me/${n.replace(/[^0-9]/g, '')}`;

export function ContactList({ ctx, c, address, show = {} }: { ctx: RenderCtx; c: StorefrontData['contact']; address?: string; show?: { phone?: boolean; email?: boolean; whatsapp?: boolean; address?: boolean } }) {
  const items: Array<{ icon: LucideIcon; label: string; value: string; href?: string; ltr?: boolean }> = [];
  if (show.phone !== false && c.phone) items.push({ icon: Phone, label: tr(ctx, 'phone'), value: c.phone, href: `tel:${c.phone}`, ltr: true });
  if (show.whatsapp !== false && c.whatsapp) items.push({ icon: MessageCircle, label: tr(ctx, 'whatsapp'), value: c.whatsapp, href: waLink(c.whatsapp), ltr: true });
  if (show.email !== false && c.email) items.push({ icon: Mail, label: tr(ctx, 'email'), value: c.email, href: `mailto:${c.email}`, ltr: true });
  if (show.address !== false && address) items.push({ icon: MapPin, label: tr(ctx, 'address'), value: address });
  if (!items.length) return null;
  return (
    <ul className="flex flex-col gap-3">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sf-primary/10 text-sf-primary"><i.icon className="size-5" aria-hidden /></span>
          <span className="flex flex-col">
            <span className="text-xs text-sf-muted">{i.label}</span>
            {i.href ? <a href={i.href} className="font-medium hover:underline" dir={i.ltr ? 'ltr' : undefined} {...(i.href.startsWith('https') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{i.value}</a> : <span className="font-medium">{i.value}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ContactBlock({ ctx, block, props }: BlockProps) {
  const b = branchFor(ctx, null);
  const address = [b?.address, b?.city].filter(Boolean).join('، ');
  const title = L(ctx, props.title) || tr(ctx, 'contact');
  const list = <ContactList ctx={ctx} c={ctx.data.contact} address={address} show={{ phone: props.show_phone, email: props.show_email, whatsapp: props.show_whatsapp, address: props.show_address }} />;
  if (!ctx.data.contact.phone && !ctx.data.contact.email && !ctx.data.contact.whatsapp && !address) return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_contact')} /></Section> : null;
  return <Section id={block.id} title={title}>{list}</Section>;
}

export const SOCIAL_ICONS: Record<string, LucideIcon> = { instagram: Camera, tiktok: Music2, snapchat: Ghost, x: AtSign, facebook: Users, youtube: PlayCircle, website: Globe };

export function SocialLinks({ ctx, style }: { ctx: RenderCtx; style: 'icons' | 'buttons' }) {
  const entries = Object.entries(ctx.data.contact.social);
  if (!entries.length) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {entries.map(([k, url]) => {
        const I = SOCIAL_ICONS[k] ?? Globe;
        const label = tr(ctx, `social.${k}`);
        return (
          <li key={k}>
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}
              className={style === 'buttons' ? 'inline-flex min-h-10 items-center gap-2 rounded-sf border border-sf-border bg-sf-surface px-4 text-sm hover:border-sf-primary' : 'inline-flex size-11 items-center justify-center rounded-full bg-sf-primary/10 text-sf-primary hover:bg-sf-primary/20'}>
              <I className="size-5" aria-hidden />{style === 'buttons' ? <span>{label}</span> : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function SocialBlock({ ctx, block, props }: BlockProps) {
  const title = L(ctx, props.title) || undefined;
  if (!Object.keys(ctx.data.contact.social).length) return ctx.canvas ? <Section id={block.id} title={title}><CanvasEmpty ctx={ctx} label={tr(ctx, 'canvas.empty_social')} /></Section> : null;
  return <Section id={block.id} title={title}><SocialLinks ctx={ctx} style={props.style === 'buttons' ? 'buttons' : 'icons'} /></Section>;
}

