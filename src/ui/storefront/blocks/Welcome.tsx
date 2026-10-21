'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { cx } from '../../components/cx';

export function WelcomeBanner({ id, message, style, dismissible, href, closeLabel, card }: { id: string; message: string; style: string; dismissible: boolean; href: string | null; closeLabel: string; card: string }) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  const text = href ? <a href={href} className="underline-offset-2 hover:underline">{message}</a> : message;
  return (
    <div id={id} role="region" aria-label={message} className={cx(style === 'card' ? 'px-4 py-3 @2xl:px-6' : '')}>
      <div className={cx('flex items-center justify-center gap-3 text-sm', style === 'card' ? cx(card, 'mx-auto max-w-6xl p-4') : 'bg-sf-accent/20 px-4 py-2 text-center')}>
        <p className="flex-1 text-center">{text}</p>
        {dismissible ? <button type="button" onClick={() => setHidden(true)} aria-label={closeLabel} className="rounded p-1 hover:bg-black/5"><X className="size-4" /></button> : null}
      </div>
    </div>
  );
}
