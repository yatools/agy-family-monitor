import { z } from 'zod';
export const integer = z.int().nonnegative().max(1_000_000_000_000);
const label = z.string().trim().min(1).max(160);
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const eventSchema = z.strictObject({
  event_id: opaque,
  session_key: opaque,
  step_index: integer,
  source: z.enum(['antigravity_cli', 'antigravity_ide']),
  model_id: label,
  model_display: label,
  occurred_at_ms: z.int().nonnegative().max(8_640_000_000_000_000),
  tokens: z.strictObject({
    input: integer,
    output: integer,
    cache_read: integer,
    cache_write: integer,
  }),
});
export const batchSchema = z.strictObject({
  batch_id: opaque,
  agent_version: z.string().min(1).max(40),
  events: z.array(eventSchema).min(1).max(100),
});
export type UsageEvent = z.infer<typeof eventSchema>;
export const enrollSchema = z.strictObject({
  code: z.string().min(8).max(256),
  device_label: label,
  platform: z.literal('windows-x64'),
  agent_version: z.string().min(1).max(40),
});
export const memberSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  display_name: label,
  role: z.enum(['admin', 'member']).default('member'),
});
export const memberPatchSchema = z
  .strictObject({
    display_name: label.optional(),
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase())
      .optional(),
    status: z.enum(['active', 'inactive']).optional(),
    notifications_enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0);
export const priceSchema = z.strictObject({
  model_id: label,
  input_price: integer,
  output_price: integer,
  cache_read_price: integer,
  cache_write_price: integer,
  effective_from: z.int().nonnegative(),
  catalog_version: label,
  source: z
    .url()
    .max(1000)
    .refine((v) => new URL(v).protocol === 'https:'),
});
export const ruleSchema = z.strictObject({
  id: z.string().max(80).optional(),
  scope: z.enum(['member', 'family']),
  member_id: z.string().max(80).nullable().default(null),
  metric: z.enum(['tokens', 'cost_micro_usd']),
  period: z.enum(['day', 'week', 'month', 'rolling_24h']),
  threshold_value: integer.positive(),
  enabled: z.boolean().default(true),
});
