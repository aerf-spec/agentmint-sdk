// Trace-link plugins for receipts, on top of the SDK's trace-links module
// (TraceLinkPlugin, otelLinks, formatTraceparent, collectTraceLinks). Each
// receipt carries signed deep links into the vendor's tracing tools: URL
// templates only, no content, no network calls, no dependencies. Trace and
// span ids are W3C format (32 / 16 hex).
import { otelLinks, type TraceLinkContext, type TraceLinkPlugin } from "../src/trace-links.js";

export { collectTraceLinks, formatTraceparent, type TraceLinkPlugin } from "../src/trace-links.js";

const enc = encodeURIComponent;

/** 32-hex W3C trace id rendered as a UUID (how OTel-ingesting tools key runs). */
export function w3cToUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fill(template: string, ctx: TraceLinkContext): string {
  return template
    .split("{trace_id}").join(ctx.trace_id)
    .split("{span_id}").join(ctx.span_id)
    .split("{trace_uuid}").join(w3cToUuid(ctx.trace_id))
    .split("{request_id}").join(enc(ctx.request_id ?? ""));
}

/**
 * Any OpenTelemetry backend via a user-supplied URL template with {trace_id}
 * and {span_id}: Jaeger, Honeycomb, Datadog, Grafana Tempo, … (SDK otelLinks).
 */
export function otel(opts: { urlTemplate: string; system?: string }): TraceLinkPlugin {
  return otelLinks(opts);
}

/**
 * LangSmith run view. The default keys the run by the W3C trace id rendered
 * as a UUID (how LangSmith's OTel ingest names runs); pass urlTemplate to
 * override with {trace_id} / {trace_uuid} / {span_id}.
 */
export function langsmith(opts: { org: string; project: string; host?: string; urlTemplate?: string }): TraceLinkPlugin {
  const host = (opts.host ?? "https://smith.langchain.com").replace(/\/$/, "");
  const template =
    opts.urlTemplate ?? `${host}/o/${enc(opts.org)}/projects/p/${enc(opts.project)}/r/{trace_uuid}?trace_id={trace_uuid}`;
  return { system: "langsmith", link: (ctx) => fill(template, ctx) };
}

/** Langfuse trace view: {host}/project/{project}/traces/{trace_id}?observation={span_id}. */
export function langfuse(opts: { host?: string; project: string }): TraceLinkPlugin {
  const host = (opts.host ?? "https://cloud.langfuse.com").replace(/\/$/, "");
  return {
    system: "langfuse",
    link: (ctx) => `${host}/project/${enc(opts.project)}/traces/${ctx.trace_id}?observation=${ctx.span_id}`,
  };
}

/** OpenAI platform traces view (Agents SDK trace ids are "trace_" + 32 hex). */
export function openaiTraces(opts: { urlTemplate?: string } = {}): TraceLinkPlugin {
  const template = opts.urlTemplate ?? "https://platform.openai.com/traces/trace?trace_id=trace_{trace_id}";
  return { system: "openai", link: (ctx) => fill(template, ctx) };
}
