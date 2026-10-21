import { z } from 'zod';
import { BLOCK_TYPES, type BlockType } from './blocks';
import { COLOR_TOKENS, FONTS, hex, zFontKey } from './theme';

/**
 * Customization assistant operation whitelist. The AI may only PROPOSE these
 * structured operations; the server validates every one against the tenant's
 * current draft before anything is applied, and applies to the draft only.
 * Prices, payment policies, appointments, permissions, links and publishing
 * are deliberately not expressible.
 */
export const ASSISTANT_OPS = [
  'set_color', 'set_font', 'set_radius', 'set_button_style', 'set_card_style', 'set_density', 'set_nav_style',
  'move_block', 'set_block_visibility', 'set_text',
] as const;
export type AssistantOpName = (typeof ASSISTANT_OPS)[number];

/** Editable text fields per block type (plain text; rich fields become paragraphs). */
export const TEXT_FIELDS: Partial<Record<BlockType, Record<string, 'short' | 'rich'>>> = {
  hero: { title: 'short', subtitle: 'short', cta_label: 'short' },
  intro: { title: 'short', body: 'rich' },
  text: { content: 'rich' },
  cta: { label: 'short' },
  welcome: { message: 'short' },
  image_ad: { caption: 'short', alt: 'short' },
  image: { alt: 'short' },
  page_link: { label: 'short', description: 'short' },
  ...Object.fromEntries((['service_list', 'categories', 'product_grid', 'team', 'gallery', 'offers', 'reviews', 'map', 'hours', 'contact', 'social', 'faq', 'policies'] as const).map((t) => [t, { title: 'short' as const }])),
};

const page_id = z.string().uuid();
const block_id = z.string().regex(/^[a-zA-Z0-9_-]{6,40}$/);
const text = (max: number) => z.string().max(max);

export const zAssistantOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_color'), token: z.enum(COLOR_TOKENS), hex }).strict(),
  z.object({ op: z.literal('set_font'), slot: z.enum(['heading', 'body']), font_key: zFontKey }).strict(),
  z.object({ op: z.literal('set_radius'), value: z.enum(['none', 'sm', 'md', 'lg', 'pill']) }).strict(),
  z.object({ op: z.literal('set_button_style'), value: z.enum(['solid', 'outline', 'soft']) }).strict(),
  z.object({ op: z.literal('set_card_style'), value: z.enum(['flat', 'bordered', 'elevated']) }).strict(),
  z.object({ op: z.literal('set_density'), value: z.enum(['compact', 'comfortable', 'spacious']) }).strict(),
  z.object({ op: z.literal('set_nav_style'), value: z.enum(['simple', 'pill', 'bottom']) }).strict(),
  z.object({ op: z.literal('move_block'), page_id, block_id, before_id: block_id.optional(), after_id: block_id.optional(), to_index: z.number().int().min(0).max(200).optional() }).strict(),
  z.object({ op: z.literal('set_block_visibility'), page_id, block_id, enabled: z.boolean() }).strict(),
  z.object({ op: z.literal('set_text'), page_id, block_id, field: z.string().max(40), ar: text(2000).optional(), en: text(2000).optional() }).strict(),
]);
export type AssistantOp = z.infer<typeof zAssistantOp>;

export type DiffEntry = { index: number; op: AssistantOpName; target: string; page_id?: string; block_id?: string; block_type?: BlockType; before: unknown; after: unknown };
export type RejectedOp = { index: number; op: string; reason: string };

/** Loose envelope accepted from the provider; each op is validated individually afterwards. */
export const zAssistantOutput = z.object({
  explanation: z.string().max(4000),
  operations: z.array(z.record(z.string(), z.unknown())).max(30),
});

const nullable = (t: string) => ({ type: [t, 'null'] });
/** Strict JSON schema for the provider (every property present; unused ones null). */
export const ASSISTANT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['explanation', 'operations'],
  properties: {
    explanation: { type: 'string', description: 'Short explanation for the owner, in the requested language.' },
    operations: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'token', 'hex', 'slot', 'font_key', 'value', 'page_id', 'block_id', 'before_id', 'after_id', 'to_index', 'enabled', 'field', 'ar', 'en'],
        properties: {
          op: { type: 'string', enum: [...ASSISTANT_OPS] },
          token: { type: ['string', 'null'], enum: [...COLOR_TOKENS, null] },
          hex: nullable('string'),
          slot: { type: ['string', 'null'], enum: ['heading', 'body', null] },
          font_key: { type: ['string', 'null'], enum: [...Object.keys(FONTS), null] },
          value: nullable('string'),
          page_id: nullable('string'),
          block_id: nullable('string'),
          before_id: nullable('string'),
          after_id: nullable('string'),
          to_index: nullable('integer'),
          enabled: nullable('boolean'),
          field: nullable('string'),
          ar: nullable('string'),
          en: nullable('string'),
        },
      },
    },
  },
} as const;

export const BLOCK_TYPE_LIST = BLOCK_TYPES;
