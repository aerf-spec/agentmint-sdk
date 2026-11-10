// Model prices (USD per 1M tokens) used for the live cost meter. One table, dated.
export const PRICES = {
  prices_as_of: "2026-11-10",
  models: {
    "claude-opus-5-5": { input: 4.0, output: 20.0, cache_read: 0.2, cache_write: 5.0 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
  } as Record<string, { input: number; output: number; cache_read: number; cache_write: number }>,
} as const;

// Cloudflare list prices for the request-count estimate (compute/duration excluded).
export const INFRA_PRICES = { workers_per_million_requests: 0.3, durable_object_per_million_requests: 0.15 };

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function priceFor(model: string | null | undefined) {
  const m = model ?? "";
  const key = Object.keys(PRICES.models).find((k) => m === k || m.startsWith(k));
  return key ? { key, p: PRICES.models[key]! } : null;
}

/** USD for one response's usage, rounded to 1e-6. Unknown models price at 0 and are flagged by the caller. */
export function usdFor(model: string | null | undefined, u: Usage): number {
  const hit = priceFor(model);
  if (!hit) return 0;
  const { p } = hit;
  const usd = (u.input_tokens * p.input + u.output_tokens * p.output + u.cache_read_input_tokens * p.cache_read + u.cache_creation_input_tokens * p.cache_write) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}
