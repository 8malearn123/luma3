'use client';

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Download, MessageCircle, QrCode, Share2 } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { encodeQr, qrPath, qrSvg } from '@/shared/qr';
import { Button } from '../components/button';
import { Dialog } from '../components/overlay';

const LOGO_SCALE = 0.22;
const MARGIN = 4;

const noopSubscribe = () => () => {};
/** Absolute store URL on the current deployment (client only; empty during SSR). */
function useStoreUrl(slug: string) {
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => '');
  return origin ? `${origin}/s/${slug}` : '';
}

async function toDataUrl(src: string): Promise<string | null> {
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
  } catch { return null; }
}

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

/**
 * Store link QR with the business logo in the centre (error correction H so
 * the logo does not break scanning): download PNG / SVG, copy the link, share
 * on WhatsApp (wa.me) or via the device share sheet.
 */
export function StoreQrCard({ slug, name, logoAssetId, compact }: { slug: string; name: string; logoAssetId?: string | null; compact?: boolean }) {
  const { t } = useI18n();
  const url = useStoreUrl(slug);
  const canShare = useSyncExternalStore(noopSubscribe, () => 'share' in navigator, () => false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'png' | 'svg' | null>(null);
  const logo = logoAssetId ? `/api/v1/media/${logoAssetId}` : null;
  const matrix = useMemo(() => (url ? encodeQr(url, { ecc: logo ? 'H' : 'M' }) : null), [url, logo]);
  const dim = matrix ? matrix.size + MARGIN * 2 : 0;
  const shareText = t('business.qr.share_text', { name });

  async function downloadSvg() {
    if (!matrix) return;
    setBusy('svg');
    try {
      const embedded = logo ? await toDataUrl(logo) : null;
      const svg = qrSvg(matrix, { margin: MARGIN, logo: embedded, logoScale: LOGO_SCALE, title: url });
      const href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      download(href, `${slug}-qr.svg`);
      setTimeout(() => URL.revokeObjectURL(href), 2000);
    } finally { setBusy(null); }
  }

  async function downloadPng() {
    if (!matrix) return;
    setBusy('png');
    try {
      const px = 1024, cell = px / dim;
      const c = document.createElement('canvas');
      c.width = px; c.height = px;
      const g = c.getContext('2d')!;
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, px, px);
      g.fillStyle = '#000000';
      for (let y = 0; y < matrix.size; y++) for (let x = 0; x < matrix.size; x++) {
        if (matrix.modules[y]![x]) g.fillRect(Math.floor((x + MARGIN) * cell), Math.floor((y + MARGIN) * cell), Math.ceil(cell), Math.ceil(cell));
      }
      if (logo) {
        const img = new Image();
        img.src = logo;
        await img.decode().catch(() => null);
        if (img.naturalWidth) {
          const s = px * LOGO_SCALE, pad = s * 0.12, o = (px - s) / 2;
          g.fillStyle = '#ffffff';
          g.beginPath(); g.roundRect(o - pad, o - pad, s + pad * 2, s + pad * 2, pad * 1.5); g.fill();
          const r = Math.min(s / img.naturalWidth, s / img.naturalHeight);
          const w = img.naturalWidth * r, h = img.naturalHeight * r;
          g.drawImage(img, o + (s - w) / 2, o + (s - h) / 2, w, h);
        }
      }
      download(c.toDataURL('image/png'), `${slug}-qr.png`);
    } finally { setBusy(null); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  }

  const wa = `https://wa.me/?text=${encodeURIComponent(`${shareText}\n${url}`)}`;

  return (
    <div className={compact ? 'flex flex-col items-center gap-3' : 'flex flex-col gap-4 sm:flex-row sm:items-center'}>
      <div className="mx-auto shrink-0 rounded-xl border border-line bg-white p-2" style={{ width: compact ? 200 : 160 }}>
        {matrix ? (
          <svg viewBox={`0 0 ${dim} ${dim}`} shapeRendering="crispEdges" role="img" aria-label={t('business.qr.alt', { url })} className="block h-auto w-full">
            <rect width={dim} height={dim} fill="#fff" />
            <path d={qrPath(matrix, MARGIN)} fill="#000" />
            {logo ? (() => {
              const s = dim * LOGO_SCALE, pad = s * 0.12, o = (dim - s) / 2;
              return <><rect x={o - pad} y={o - pad} width={s + pad * 2} height={s + pad * 2} rx={pad * 1.5} fill="#fff" /><image href={logo} x={o} y={o} width={s} height={s} preserveAspectRatio="xMidYMid meet" /></>;
            })() : null}
          </svg>
        ) : <div className="flex aspect-square items-center justify-center"><QrCode className="size-10 text-luma-200" aria-hidden /></div>}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="truncate rounded-lg bg-luma-50 px-2 py-1 text-xs text-ink-muted" dir="ltr">{url}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={copy} disabled={!url}>{copied ? t('business.qr.copied') : t('business.qr.copy')}</Button>
          <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#25D366] px-3 text-sm font-medium text-white hover:opacity-90">
            <MessageCircle className="size-4" aria-hidden />{t('business.qr.whatsapp')}
          </a>
          {canShare ? <Button size="sm" variant="ghost" icon={<Share2 className="size-4" />} onClick={() => { void navigator.share({ title: name, text: shareText, url }).catch(() => null); }}>{t('business.qr.share')}</Button> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} loading={busy === 'png'} onClick={downloadPng} disabled={!matrix}>PNG</Button>
          <Button size="sm" variant="ghost" icon={<Download className="size-4" />} loading={busy === 'svg'} onClick={downloadSvg} disabled={!matrix}>SVG</Button>
        </div>
      </div>
    </div>
  );
}

/** Toolbar button (storefront builder) opening the store QR. */
export function StoreQrButton({ slug, name, logoAssetId }: { slug: string; name: string; logoAssetId?: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" icon={<QrCode className="size-4" />} onClick={() => setOpen(true)}>{t('business.qr.button')}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('business.qr.title')} footer={<Button variant="ghost" onClick={() => setOpen(false)}>{t('actions.close')}</Button>}>
        <StoreQrCard slug={slug} name={name} logoAssetId={logoAssetId} compact />
      </Dialog>
    </>
  );
}
