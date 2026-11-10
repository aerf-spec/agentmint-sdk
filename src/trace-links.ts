// Trace-link plugins: tie a receipt to the distributed trace it came from.
//
// When a notarised action carries a W3C trace context, the receipt's evidence
// gains a signed `traceparent` and, per configured plugin, a deep link into an
// observability system. Plugins are generic URL builders; no vendor URLs ship
// with the SDK.
import { AerfReceiptError } from "./receipt-aerf.js";

/** W3C trace context for one notarised action. */
export interface TraceContext {
  /** 32 lowercase hex chars, not all zero. */
  trace_id: string;
  /** 16 lowercase hex chars, not all zero. */
  span_id: string;
  request_id?: string;
}

export interface TraceLinkContext extends TraceContext {
  /** observed_at of the receipt being issued. */
  started_at: string;
}

export interface TraceLinkPlugin {
  /** Short system name recorded on the link, e.g. "otel". */
  system: string;
  /** A URL for the trace, or undefined to contribute no link. */
  link(ctx: TraceLinkContext): string | undefined;
}

export interface TraceLink {
  system: string;
  url: string;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/** Validate W3C trace-context IDs; throws AerfReceiptError when malformed. */
export function validateTraceContext(trace: TraceContext): void {
  if (typeof trace !== "object" || trace === null) {
    throw new AerfReceiptError("trace must be an object with trace_id and span_id");
  }
  if (typeof trace.trace_id !== "string" || !TRACE_ID_RE.test(trace.trace_id) || /^0+$/.test(trace.trace_id)) {
    throw new AerfReceiptError("trace.trace_id must be 32 lowercase hex characters, not all zero (W3C trace-context)");
  }
  if (typeof trace.span_id !== "string" || !SPAN_ID_RE.test(trace.span_id) || /^0+$/.test(trace.span_id)) {
    throw new AerfReceiptError("trace.span_id must be 16 lowercase hex characters, not all zero (W3C trace-context)");
  }
  if (trace.request_id !== undefined && typeof trace.request_id !== "string") {
    throw new AerfReceiptError("trace.request_id must be a string when present");
  }
}

/** W3C traceparent header value (version 00, sampled flag set). */
export function formatTraceparent(trace: TraceContext): string {
  validateTraceContext(trace);
  return `00-${trace.trace_id}-${trace.span_id}-01`;
}

/**
 * Run every plugin and collect the links it returns. A plugin that throws or
 * returns a non-string / empty value contributes nothing.
 */
export function collectTraceLinks(plugins: readonly TraceLinkPlugin[], ctx: TraceLinkContext): TraceLink[] {
  const links: TraceLink[] = [];
  for (const plugin of plugins) {
    let url: unknown;
    try {
      url = plugin.link(ctx);
    } catch {
      continue;
    }
    if (typeof url === "string" && url !== "") links.push({ system: plugin.system, url });
  }
  return links;
}

/**
 * Generic OpenTelemetry link builder: substitutes `{trace_id}` and
 * `{span_id}` into a URL template pointing at your own trace UI, e.g.
 * `https://traces.example.internal/trace/{trace_id}?span={span_id}`.
 */
export function otelLinks(opts: { urlTemplate: string; system?: string }): TraceLinkPlugin {
  if (typeof opts?.urlTemplate !== "string" || !opts.urlTemplate.includes("{trace_id}")) {
    throw new TypeError("otelLinks: urlTemplate must be a string containing {trace_id}");
  }
  const template = opts.urlTemplate;
  return {
    system: opts.system ?? "otel",
    link: (ctx) => template.split("{trace_id}").join(ctx.trace_id).split("{span_id}").join(ctx.span_id),
  };
}
