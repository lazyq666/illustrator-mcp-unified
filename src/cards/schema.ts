import { z } from 'zod';
import { isAbsolute } from 'node:path';

export const absolutePath = z.string().min(1).refine(isAbsolute, 'Use an absolute file path');
export const bounds = z.array(z.number()).length(4)
  .refine(v => v[2] > v[0] && v[1] > v[3], 'Bounds are [left, top, right, bottom] in Illustrator document points');
export const layerPath = z.array(z.string().min(1)).min(1);
export const backingSchema = z.object({
  backing_name: z.string().min(1).optional(),
  offset_pt: z.number().positive().max(100),
  gradient_name: z.string().optional(),
  angle: z.number().default(0),
  stops: z.array(z.object({ position: z.number().min(0).max(100), rgb: z.array(z.number().min(0).max(255)).length(3) })).min(2).optional(),
}).refine(v => Boolean(v.gradient_name || v.stops), 'Supply a template gradient name or explicit stops');

export const imageSchema = z.object({
  item_name: z.string().min(1), file_path: absolutePath, embed: z.boolean(),
  require_clipping: z.boolean().default(true),
});
export const textSchema = z.object({ item_name: z.string().min(1), contents: z.string(), font_size: z.number().positive().optional() });
export const nameArtSchema = z.object({
  pdf_path: absolutePath, page: z.number().int().min(1).default(1),
  layer_path: layerPath, group_name: z.string().min(1), replace_item_name: z.string().optional(),
  fit_bounds: bounds, backing: backingSchema.optional(),
});
export const cardSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, 'Card id must be safe for filenames'), name: z.string().min(1),
  texts: z.array(textSchema).default([]), images: z.array(imageSchema).default([]),
  name_art: nameArtSchema.optional(), aligned_image_pairs: z.array(z.array(z.string()).length(2)).default([]),
});

export const batchShape = {
  template_path: absolutePath.describe('Saved, normalized AI template; original file is preserved'),
  output_path: absolutePath.describe('New .ai path; existing outputs are refused'),
  template_artboard: z.number().int().min(0).default(0),
  columns: z.number().int().min(1).max(20).default(4), gap_pt: z.number().min(0).max(500).default(20),
  cards: z.array(cardSchema).min(1).max(100),
  expected_sublayers: z.array(z.string()).optional(),
};
export const batchSchema = z.object(batchShape).superRefine((plan, ctx) => {
  if (new Set(plan.cards.map(c => c.id)).size !== plan.cards.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate card ids' });
  if (plan.template_path === plan.output_path) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Output must differ from template' });
  if (!/\.ai$/i.test(plan.output_path)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Output must be .ai' });
});
export type BatchPlan = z.infer<typeof batchSchema>;
