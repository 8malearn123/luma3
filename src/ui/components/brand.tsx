/* LUMA's own marks, extracted as vectors from the brand guide. Used only on LUMA surfaces. */

/**
 * The plum artwork on light surfaces; inside a dark `.luma-app` the white artwork is shown
 * instead (globals.css `.luma-on-light` / `.luma-on-dark`), so the mark stays legible.
 * `white` forces the white artwork (on the primary colour).
 */
function BrandImage({ base, white, alt, className }: { base: string; white?: boolean; alt: string; className?: string }) {
  if (white) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`${base}-white.svg`} alt={alt} className={className} />;
  }
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${base}.svg`} alt={alt} className={className ? `luma-on-light ${className}` : 'luma-on-light'} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`${base}-white.svg`} alt={alt} className={className ? `luma-on-dark ${className}` : 'luma-on-dark'} />
    </>
  );
}

export function LumaMark({ className, title = 'LUMA', white }: { className?: string; title?: string; white?: boolean }) {
  return <BrandImage base="/brand/luma-mark" white={white} alt={title} className={className} />;
}

export function LumaLogo({ className, variant = 'horizontal', white }: { className?: string; variant?: 'horizontal' | 'vertical'; white?: boolean }) {
  return <BrandImage base={`/brand/luma-logo-${variant}`} white={white} alt="LUMA" className={className} />;
}
