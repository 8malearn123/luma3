'use client';

import { useId, useState } from 'react';
import { MoveHorizontal } from 'lucide-react';

/**
 * Before/after comparison. The divider is a native range input (keyboard:
 * arrows, Home/End, Page Up/Down; screen readers announce the percentage),
 * layered over the two images. The "before" image covers the start side.
 */
export function BeforeAfterSlider({ beforeSrc, afterSrc, beforeAlt, afterAlt, labels, start = 50, rtl, showLabels, eager }: {
  beforeSrc: string; afterSrc: string; beforeAlt: string; afterAlt: string; rtl: boolean; showLabels: boolean; start?: number; eager?: boolean;
  labels: { before: string; after: string; slider: string; valueText: string };
}) {
  const [pos, setPos] = useState(start);
  const id = useId();
  // Clip the "before" image to the start side (left in LTR, right in RTL).
  const clip = rtl ? `inset(0 0 0 ${100 - pos}%)` : `inset(0 ${100 - pos}% 0 0)`;
  const edge = rtl ? { right: `${pos}%` } : { left: `${pos}%` };
  return (
    <div className="relative isolate aspect-[4/5] w-full touch-pan-y select-none overflow-hidden rounded-sf bg-sf-surface" dir={rtl ? 'rtl' : 'ltr'}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={afterSrc} alt={afterAlt} loading={eager ? 'eager' : 'lazy'} decoding="async" className="absolute inset-0 size-full object-cover" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={beforeSrc} alt={beforeAlt} loading={eager ? 'eager' : 'lazy'} decoding="async" className="absolute inset-0 size-full object-cover" style={{ clipPath: clip }} />
      {showLabels ? (
        <>
          <span className="absolute top-2 start-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white" aria-hidden>{labels.before}</span>
          <span className="absolute top-2 end-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white" aria-hidden>{labels.after}</span>
        </>
      ) : null}
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.2)] rtl:translate-x-1/2" style={edge} aria-hidden>
        <span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow">
          <MoveHorizontal className="size-4" />
        </span>
      </div>
      <label htmlFor={id} className="sr-only">{labels.slider}</label>
      <input id={id} type="range" min={0} max={100} step={1} value={pos} dir={rtl ? 'rtl' : 'ltr'}
        aria-valuetext={labels.valueText.replace('{n}', String(pos))}
        onChange={(e) => setPos(Number(e.target.value))}
        className="peer absolute inset-0 z-10 size-full cursor-ew-resize appearance-none bg-transparent opacity-0" />
      <span className="pointer-events-none absolute inset-0 rounded-sf ring-sf-primary peer-focus-visible:ring-4" aria-hidden />
    </div>
  );
}
