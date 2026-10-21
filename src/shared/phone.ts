/**
 * Phone normalisation to E.164. Saudi local formats (05XXXXXXXX, 5XXXXXXXX,
 * 9665XXXXXXXX, 009665XXXXXXXX) become +9665XXXXXXXX. Other countries must be
 * entered with a leading + and country code.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  let v = digits;
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  if (/^05\d{8}$/.test(v)) v = `+966${v.slice(1)}`;
  else if (/^5\d{8}$/.test(v)) v = `+966${v}`;
  else if (/^9665\d{8}$/.test(v)) v = `+${v}`;
  if (!/^\+[1-9]\d{7,14}$/.test(v)) return null;
  if (v.startsWith('+966') && !/^\+9665\d{8}$/.test(v)) return null;
  return v;
}

export function isEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
}

/** Classifies a login identifier as email or phone (normalised), or null. */
export function parseIdentifier(raw: string): { kind: 'email'; value: string } | { kind: 'phone'; value: string } | null {
  const v = raw.trim();
  if (isEmail(v)) return { kind: 'email', value: v.toLowerCase() };
  const p = normalizePhone(v);
  return p ? { kind: 'phone', value: p } : null;
}
