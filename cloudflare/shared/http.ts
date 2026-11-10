// HTTP hardening shared by the filet Workers: CORS allowlist, per-IP rate
// limiting (a tiny Durable Object counter), capped body reads and strict
// JSON object validation (unknown fields rejected).

import { DurableObject } from "cloudflare:workers";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

// https://filet-demo.pages.dev, its preview deployments (<hash|branch>.filet-demo.pages.dev),
// and localhost / 127.0.0.1 on any port for development.
const ORIGIN_RE = /^(?:https:\/\/(?:[a-z0-9-]+\.)?filet-demo\.pages\.dev|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/;

export function allowedOrigin(req: Request): string | null {
  const o = req.headers.get("origin");
  return o && ORIGIN_RE.test(o) ? o : null;
}

export function corsHeaders(req: Request, methods: string, headers = "content-type"): Record<string, string> {
  const o = allowedOrigin(req);
  if (!o) return { vary: "Origin" };
  return {
    "access-control-allow-origin": o,
    "access-control-allow-methods": methods,
    "access-control-allow-headers": headers,
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

/** Preflight: 204 with CORS headers for allowlisted origins, 403 otherwise. */
export function preflight(req: Request, methods: string, headers = "content-type"): Response {
  if (!allowedOrigin(req)) return new Response(null, { status: 403, headers: { vary: "Origin" } });
  const want = (req.headers.get("access-control-request-method") ?? "").toUpperCase();
  if (want && !methods.split(/,\s*/).includes(want)) return new Response(null, { status: 403, headers: { vary: "Origin" } });
  return new Response(null, { status: 204, headers: corsHeaders(req, methods, headers) });
}

/**
 * Browsers attach Origin to cross-site POSTs. A POST carrying a non-allowlisted
 * Origin is refused (CSRF-style abuse from other sites). Server-to-server
 * callers (no Origin) are allowed; they still face auth and rate limits.
 */
export function assertPostOrigin(req: Request): void {
  const o = req.headers.get("origin");
  if (o && !ORIGIN_RE.test(o)) throw new HttpError(403, "origin not allowed");
}

export async function readCappedJson(req: Request, maxBytes: number): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, `body exceeds ${maxBytes} bytes`);
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, "content-type must be application/json");
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "body required");
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf));
  } catch {
    throw new HttpError(400, "body must be valid UTF-8 JSON");
  }
}

/** Require a plain object whose keys are exactly within `allowed` and include `required`. */
export function strictObject(v: unknown, allowed: string[], required: string[] = allowed): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new HttpError(400, `unknown field: ${k.slice(0, 40)}`);
  for (const k of required) if (!(k in o)) throw new HttpError(400, `missing field: ${k}`);
  return o;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function requireBearer(req: Request, secret: string | undefined): void {
  if (!secret) throw new HttpError(503, "auth not configured");
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer (\S+)$/.exec(h);
  if (!m || !timingSafeEqual(m[1]!, secret)) throw new HttpError(401, "unauthorized", { "www-authenticate": "Bearer" });
}

// ── Rate limiting ───────────────────────────────────────────────────

/**
 * One instance per client IP (idFromName(ip)). Sliding one-minute window per
 * bucket, in memory: a DO restart forgets counts, which only ever loosens the
 * limit briefly. Simplest effective version, no storage writes on the hot path.
 */
export class RateLimiter extends DurableObject {
  private hits = new Map<string, number[]>();

  async check(bucket: string, limit: number, windowMs: number): Promise<{ ok: boolean; retryAfter: number }> {
    const now = Date.now();
    const arr = (this.hits.get(bucket) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(bucket, arr);
      return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - arr[0]!)) / 1000)) };
    }
    arr.push(now);
    this.hits.set(bucket, arr);
    return { ok: true, retryAfter: 0 };
  }
}

export interface RateLimitEnv {
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
}

/** Rate-limit by CF-Connecting-IP. Requests without it (service bindings) are internal and skip. */
export async function rateLimit(env: RateLimitEnv, req: Request, bucket: string, perMinute: number): Promise<void> {
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip) return;
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
  const r = await stub.check(bucket, perMinute, 60_000);
  if (!r.ok) throw new HttpError(429, "rate limited", { "retry-after": String(r.retryAfter) });
}
