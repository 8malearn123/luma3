'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Minus, Move, Plus } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Dialog } from '../components/overlay';
import { cx } from '../components/cx';

export type CropRect = { x: number; y: number; width: number; height: number };

/** Frame shapes offered per upload purpose (first = default). */
export const CROP_ASPECTS: Record<string, Array<{ key: string; ratio: number }>> = {
  logo: [{ key: '1:1', ratio: 1 }],
  cover: [{ key: '3:1', ratio: 3 }, { key: '16:9', ratio: 16 / 9 }, { key: '4:3', ratio: 4 / 3 }],
  service: [{ key: '4:3', ratio: 4 / 3 }, { key: '1:1', ratio: 1 }, { key: '16:9', ratio: 16 / 9 }],
  product: [{ key: '1:1', ratio: 1 }, { key: '4:3', ratio: 4 / 3 }, { key: '3:4', ratio: 3 / 4 }],
  staff: [{ key: '1:1', ratio: 1 }, { key: '3:4', ratio: 3 / 4 }],
};
export const isCroppable = (purpose: string) => purpose in CROP_ASPECTS;

const MAX_ZOOM = 5;

/**
 * Pure geometry: the crop rectangle (natural pixels) for an image of nw×nh
 * shown "cover"-fitted in a vw×vh frame at `zoom`, offset by (ox, oy) ≤ 0.
 */
export function cropFromView(nw: number, nh: number, vw: number, vh: number, zoom: number, ox: number, oy: number): CropRect {
  const scale = Math.max(vw / nw, vh / nh) * zoom;
  return { x: Math.max(0, -ox / scale), y: Math.max(0, -oy / scale), width: Math.min(nw, vw / scale), height: Math.min(nh, vh / scale) };
}

function clampOffset(nw: number, nh: number, vw: number, vh: number, zoom: number, ox: number, oy: number) {
  const scale = Math.max(vw / nw, vh / nh) * zoom;
  const dw = nw * scale, dh = nh * scale;
  return { ox: Math.min(0, Math.max(vw - dw, ox)), oy: Math.min(0, Math.max(vh - dh, oy)) };
}

/**
 * Interactive crop: drag (mouse/touch) or arrow keys to pan, wheel / slider /
 * buttons to zoom, choose the frame shape. Returns the crop rectangle in the
 * image's natural pixels (EXIF orientation already applied by the browser,
 * matching the server pipeline).
 */
export function CropEditor({ src, purpose, onCancel, onConfirm, onSkip, busy, error }: {
  src: string; purpose: string; onCancel: () => void; onConfirm: (crop: CropRect) => void; onSkip?: () => void; busy?: boolean; error?: ReactNode;
}) {
  const { t } = useI18n();
  const aspects = CROP_ASPECTS[purpose] ?? [{ key: '1:1', ratio: 1 }];
  const [aspect, setAspect] = useState(aspects[0]!);
  const box = useRef<HTMLDivElement>(null);
  const [vw, setVw] = useState(320);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ ox: 0, oy: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const vh = Math.round(vw / aspect.ratio);

  useLayoutEffect(() => {
    const el = box.current?.parentElement;
    if (el) setVw(Math.min(400, Math.max(200, Math.floor(el.clientWidth))));
  }, []);

  const centered = (n: { w: number; h: number }, z: number, w: number, h: number) => {
    const sc = Math.max(w / n.w, h / n.h) * z;
    return clampOffset(n.w, n.h, w, h, z, (w - n.w * sc) / 2, (h - n.h * sc) / 2);
  };

  const setZoomAround = (z: number) => {
    if (!nat) return;
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    // Keep the frame centre fixed while zooming.
    const s0 = Math.max(vw / nat.w, vh / nat.h);
    const cx0 = (vw / 2 - off.ox) / (s0 * zoom), cy0 = (vh / 2 - off.oy) / (s0 * zoom);
    setZoom(nz);
    setOff(clampOffset(nat.w, nat.h, vw, vh, nz, vw / 2 - cx0 * s0 * nz, vh / 2 - cy0 * s0 * nz));
  };
  const pan = (dx: number, dy: number) => { if (nat) setOff((o) => clampOffset(nat.w, nat.h, vw, vh, zoom, o.ox + dx, o.oy + dy)); };

  const scale = nat ? Math.max(vw / nat.w, vh / nat.h) * zoom : 1;
  const crop = nat ? cropFromView(nat.w, nat.h, vw, vh, zoom, off.ox, off.oy) : null;

  return (
    <Dialog open onClose={onCancel} title={t('business.crop.title')} footer={<>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>{t('actions.cancel')}</Button>
      {onSkip ? <Button variant="outline" onClick={onSkip} disabled={busy}>{t('business.crop.skip')}</Button> : null}
      <Button loading={busy} disabled={!crop} onClick={() => crop && onConfirm(crop)}>{t('business.crop.apply')}</Button>
    </>}>
      <div className="flex flex-col items-center gap-3">
        {aspects.length > 1 ? (
          <div role="radiogroup" aria-label={t('business.crop.shape')} className="flex gap-1">
            {aspects.map((a) => (
              <button key={a.key} type="button" role="radio" aria-checked={a.key === aspect.key} onClick={() => { setAspect(a); setZoom(1); if (nat) setOff(centered(nat, 1, vw, Math.round(vw / a.ratio))); }}
                className={cx('rounded-lg border px-2.5 py-1 text-xs', a.key === aspect.key ? 'border-luma-700 bg-luma-700 text-white' : 'border-line hover:bg-luma-50')} dir="ltr">{a.key}</button>
            ))}
          </div>
        ) : null}
        <div ref={box} tabIndex={0} role="application" aria-label={t('business.crop.area')} aria-roledescription={t('business.crop.area')}
          className={cx('relative cursor-grab touch-none select-none overflow-hidden bg-luma-50 outline-none ring-luma-500 focus-visible:ring-2 active:cursor-grabbing', purpose === 'logo' ? 'rounded-full' : 'rounded-lg')}
          style={{ width: vw, height: vh }}
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.ox, oy: off.oy }; }}
          onPointerMove={(e) => { const d = drag.current; if (d && nat) setOff(clampOffset(nat.w, nat.h, vw, vh, zoom, d.ox + e.clientX - d.x, d.oy + e.clientY - d.y)); }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
          onWheel={(e) => setZoomAround(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 40 : 10;
            if (e.key === 'ArrowLeft') pan(step, 0); else if (e.key === 'ArrowRight') pan(-step, 0);
            else if (e.key === 'ArrowUp') pan(0, step); else if (e.key === 'ArrowDown') pan(0, -step);
            else if (e.key === '+' || e.key === '=') setZoomAround(zoom * 1.1); else if (e.key === '-') setZoomAround(zoom / 1.1);
            else return;
            e.preventDefault();
          }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="" draggable={false} className="pointer-events-none absolute max-w-none origin-top-left"
            style={nat ? { left: off.ox, top: off.oy, width: nat.w * scale, height: nat.h * scale } : { opacity: 0 }}
            onLoad={(e) => { const n = { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }; setNat(n); setZoom(1); setOff(centered(n, 1, vw, vh)); }} />
          <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3" aria-hidden>
            {Array.from({ length: 9 }, (_, i) => <span key={i} className="border border-white/30" />)}
          </div>
        </div>
        <div className="flex w-full max-w-xs items-center gap-2">
          <button type="button" className="rounded-md p-1 hover:bg-luma-100" aria-label={t('business.crop.zoom_out')} onClick={() => setZoomAround(zoom / 1.2)}><Minus className="size-4" /></button>
          <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => setZoomAround(Number(e.target.value))} className="flex-1 accent-luma-700" aria-label={t('business.crop.zoom')} />
          <button type="button" className="rounded-md p-1 hover:bg-luma-100" aria-label={t('business.crop.zoom_in')} onClick={() => setZoomAround(zoom * 1.2)}><Plus className="size-4" /></button>
        </div>
        <p className="flex items-center gap-1 text-xs text-ink-muted"><Move className="size-3.5" aria-hidden />{t('business.crop.help')}</p>
        {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
        {crop ? <p className="text-[11px] text-ink-muted" dir="ltr">{Math.round(crop.width)} × {Math.round(crop.height)} px</p> : null}
      </div>
    </Dialog>
  );
}

/**
 * Upload flow with cropping for logo / cover / service / product / staff images.
 * `pick(file)` opens the editor (other purposes upload directly);
 * `recrop(assetId)` cuts a new derived asset from an existing image.
 */
export function useCropUpload(slug: string, purpose: string, onUploaded: (r: { id: string; width: number; height: number }) => void) {
  const [state, setState] = useState<{ src: string; file?: File; assetId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const msg = useErrorMessage();

  useEffect(() => () => { if (state?.file) URL.revokeObjectURL(state.src); }, [state]);

  const upload = useCallback(async (file: File, crop?: CropRect) => {
    const fd = new FormData(); fd.set('file', file); fd.set('purpose', purpose);
    if (crop) fd.set('crop', JSON.stringify(crop));
    setBusy(true); setError(null);
    try { onUploaded(await api<{ id: string; width: number; height: number }>(`/api/v1/t/${slug}/assets`, { form: fd })); setState(null); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }, [slug, purpose, onUploaded]);

  const pick = useCallback((file: File) => {
    setError(null);
    if (!isCroppable(purpose) || file.type === 'image/gif') { void upload(file); return; }
    setState({ src: URL.createObjectURL(file), file });
  }, [purpose, upload]);

  const recrop = useCallback((assetId: string) => { setError(null); setState({ src: `/api/v1/media/${assetId}`, assetId }); }, []);

  const confirm = async (crop: CropRect) => {
    if (!state) return;
    if (state.file) { await upload(state.file, crop); return; }
    setBusy(true); setError(null);
    try {
      onUploaded(await api<{ id: string; width: number; height: number }>(`/api/v1/t/${slug}/assets/${state.assetId}/crop`, { body: { crop, purpose } }));
      setState(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const dialog: ReactNode = state ? (
    <CropEditor src={state.src} purpose={purpose} busy={busy} error={error ? msg(error) : null} onCancel={() => setState(null)} onConfirm={(c) => { void confirm(c); }}
      onSkip={state.file ? () => { void upload(state.file!); } : undefined} />
  ) : null;
  return { pick, recrop, dialog, busy, error, canCrop: isCroppable(purpose) };
}
