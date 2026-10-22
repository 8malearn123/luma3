/* LUMA's own marks, extracted as vectors from the brand guide. Used only on LUMA surfaces. */
export function LumaMark({ className, title = 'LUMA', white }: { className?: string; title?: string; white?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/brand/luma-mark${white ? '-white' : ''}.svg`} alt={title} className={className} />;
}

export function LumaLogo({ className, variant = 'horizontal', white }: { className?: string; variant?: 'horizontal' | 'vertical'; white?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/brand/luma-logo-${variant}${white ? '-white' : ''}.svg`} alt="LUMA" className={className} />;
}
