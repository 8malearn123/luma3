import type { SectorPack } from '../sector/types';
import { L, type Localized } from '../util/text';

/**
 * Awareness-only rule (§12.2) as a PURE function for the validator (phase 3)
 * and for attachments here. When a suggestion is tied to an awareness-only
 * event (health days), it:
 *   - must not be coupled to a direct discount (no discount_bp, no discount
 *     action, no discount/coupon/percentage wording in the same text);
 *   - must not make therapeutic or medical claims (the pack's forbiddenClaims
 *     plus a fixed list);
 *   - is framed as awareness content (framing = 'awareness_only').
 * A promotion may only exist as a SEPARATE item without the event link.
 */
export type AwarenessViolation = 'discount_coupling' | 'therapeutic_claim' | 'missing_awareness_framing';
export type AwarenessCheckInput = {
  awareness_only: boolean;
  text: string | Localized | Array<string | Localized>;
  discount_bp?: number | null;
  action_kind?: string | null;
  framing?: 'standard' | 'awareness_only' | null;
};
export type AwarenessCheckResult = { ok: boolean; violations: AwarenessViolation[]; messages: Localized[] };

const DISCOUNT_RE = /(خصم|تخفيض|تخفيضات|كوبون|كود|عرض خاص|مجاني|بنصف السعر|%|٪|\bdiscount|\boff\b|\bsale\b|coupon|promo ?code|\bfree\b|half price|\bdeal\b)/i;
const CLAIM_RE = /(يعالج|علاج|يشفي|شفاء|يقي من|يمنع السرطان|يحمي من|طبي|مضمون|cures?\b|treats?\b|treatment|heals?\b|prevents? (?:cancer|diabetes)|medical|clinically proven|guaranteed)/i;

const texts = (t: AwarenessCheckInput['text']): string[] => (Array.isArray(t) ? t : [t]).flatMap((x) => (typeof x === 'string' ? [x] : [x.ar, x.en]));

export function checkAwarenessRule(input: AwarenessCheckInput, pack?: Pick<SectorPack, 'validation'>): AwarenessCheckResult {
  if (!input.awareness_only) return { ok: true, violations: [], messages: [] };
  const all = texts(input.text).join('\n');
  const v = new Set<AwarenessViolation>();
  if ((input.discount_bp ?? 0) > 0 || input.action_kind === 'limited_discount' || DISCOUNT_RE.test(all)) v.add('discount_coupling');
  if (CLAIM_RE.test(all) || (pack?.validation.forbiddenClaims ?? []).some((re) => re.test(all))) v.add('therapeutic_claim');
  if (input.framing !== undefined && input.framing !== 'awareness_only') v.add('missing_awareness_framing');
  const msg: Record<AwarenessViolation, Localized> = {
    discount_coupling: L('مناسبة توعوية: لا يُربط بها خصم مباشر؛ أي عرض يكون بندًا منفصلًا دون ذكر المناسبة.', 'Awareness event: no direct discount may be tied to it; any offer must be a separate item without the event.'),
    therapeutic_claim: L('مناسبة توعوية: يُمنع أي ادعاء علاجي أو طبي.', 'Awareness event: no therapeutic or medical claims.'),
    missing_awareness_framing: L('يجب أن يُصاغ المحتوى بصيغة توعوية.', 'The content must be framed as awareness.'),
  };
  const violations = [...v];
  return { ok: violations.length === 0, violations, messages: violations.map((x) => msg[x]) };
}

/** Framing note added to any suggestion attached to an awareness-only event. */
export const AWARENESS_FRAMING: Localized = L(
  'صياغة توعوية فقط: معلومة مفيدة ودعوة للفحص لدى المختصين، دون خصم ودون أي ادعاء علاجي.',
  'Awareness framing only: helpful information and an invitation to see a specialist, with no discount and no therapeutic claim.',
);
