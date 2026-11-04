import type { Price } from './types';
import type { UsageEvent } from './schema';
export function priced(
  event: UsageEvent,
  prices: Price[],
): {
  cost_micro_usd: number | null;
  price_id: string | null;
  pricing_status: 'priced' | 'unpriced';
} {
  const canonical = (value: string) =>
    value.toLowerCase().replace(/^(claude-(?:opus|sonnet|fable))-(\d+)\.(\d+)(?=-|$)/, '$1-$2-$3');
  const model = canonical(event.model_id);
  const base = model.replace(/(?:-(?:high|medium|low|thinking|tiered))+$/, '');
  const match = (name: string) =>
    prices
      .filter((p) => canonical(p.model_id) === name && p.effective_from <= event.occurred_at_ms)
      .sort(
        (a, b) =>
          b.effective_from - a.effective_from ||
          (b.catalog_revision ?? 0) - (a.catalog_revision ?? 0) ||
          b.catalog_version.localeCompare(a.catalog_version),
      )[0];
  const price = match(model) ?? (base !== model ? match(base) : undefined);
  if (!price) return { cost_micro_usd: null, price_id: null, pricing_status: 'unpriced' };
  const t = event.tokens;
  const numerator =
    BigInt(t.input) * BigInt(price.input_price) +
    BigInt(t.output) * BigInt(price.output_price) +
    BigInt(t.cache_read) * BigInt(price.cache_read_price) +
    BigInt(t.cache_write) * BigInt(price.cache_write_price);
  const cost = (numerator + 500000n) / 1000000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cost_overflow');
  return { cost_micro_usd: Number(cost), price_id: price.id, pricing_status: 'priced' };
}
