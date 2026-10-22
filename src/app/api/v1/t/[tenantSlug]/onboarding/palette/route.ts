import { z } from 'zod';
import { route } from '@/server/http/route';
import { suggestPalette, suggestPaletteFromLogo } from '@/server/domains/onboarding/service';
import { hex } from '@/shared/builder/theme';

/**
 * POST palette suggestions — from a logo asset (stored as pending, needs owner
 * acceptance) or from chosen colours (preview only).
 */
export const POST = route({
  auth: 'tenant',
  capability: ['business.manage', 'builder.edit'],
  input: z.object({
    logo_asset_id: z.string().uuid().optional(),
    seeds: z.array(hex).max(4).optional(),
    excluded: z.array(hex).max(6).default([]),
    mood: z.enum(['soft', 'bold', 'classic']).default('classic'),
  }),
  handler: async ({ tenant, input }) => {
    if (input.logo_asset_id) return { data: await suggestPaletteFromLogo(tenant, input.logo_asset_id, input.mood) };
    return { data: { seeds: input.seeds ?? [], palette: suggestPalette(input.seeds ?? [], input.mood, input.excluded) } };
  },
});
