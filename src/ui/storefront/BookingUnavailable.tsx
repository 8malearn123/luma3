import { CalendarX2, MessageCircle, Phone } from 'lucide-react';
import { cx } from '../components/cx';
import { btnClass, cardClass, containerClass, headingClass, sectionClass } from './theme';
import { hrefHome, hrefPage, pageByKind, tr, type RenderCtx } from './context';

/**
 * Shown instead of the booking flow when the live store has nothing that can be
 * booked online (LUMA-AUDIT-017): a clear message and a way to reach the
 * business — never an empty picker.
 */
export function BookingUnavailable({ ctx }: { ctx: RenderCtx }) {
  const c = ctx.data.contact;
  const contactPage = pageByKind(ctx, 'contact');
  const wa = c.whatsapp ? `https://wa.me/${c.whatsapp.replace(/[^\d]/g, '')}` : null;
  return (
    <section className={sectionClass}>
      <div className={cx(containerClass, 'max-w-xl')}>
        <div role="status" className={cx(cardClass(ctx.data.brand), 'flex flex-col items-center gap-3 p-6 text-center')}>
          <CalendarX2 className="size-10 text-sf-muted" aria-hidden />
          <h1 className={cx(headingClass, 'text-2xl font-semibold')}>{tr(ctx, 'booking_unavailable_title')}</h1>
          <p className="text-sf-muted">{tr(ctx, 'booking_unavailable_hint')}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {c.phone ? <a className={btnClass(ctx.data.brand, 'primary')} href={`tel:${c.phone}`} dir="ltr"><Phone className="size-4" aria-hidden />{c.phone}</a> : null}
            {wa ? <a className={btnClass(ctx.data.brand, c.phone ? 'outline' : 'primary')} href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle className="size-4" aria-hidden />{tr(ctx, 'whatsapp')}</a> : null}
            {contactPage ? <a className={btnClass(ctx.data.brand, 'outline')} href={hrefPage(ctx, contactPage)}>{tr(ctx, 'contact')}</a> : null}
            <a className={btnClass(ctx.data.brand, 'secondary')} href={hrefHome(ctx)}>{tr(ctx, 'back_to_store')}</a>
          </div>
        </div>
      </div>
    </section>
  );
}
