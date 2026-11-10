import { describe, expect, it } from "vitest";
import { collectTraceLinks, formatTraceparent, langfuse, langsmith, openaiTraces, otel, w3cToUuid } from "./links.js";

const ctx = { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7", request_id: "req_1", started_at: "2026-11-10T20:00:00.000000+00:00" };

describe("trace-link plugins", () => {
  it("otel: user template with {trace_id} / {span_id} (Jaeger, Honeycomb, Tempo, Datadog)", () => {
    expect(otel({ urlTemplate: "http://localhost:16686/trace/{trace_id}?uiFind={span_id}" }).link(ctx)).toBe(
      "http://localhost:16686/trace/4bf92f3577b34da6a3ce929d0e0e4736?uiFind=00f067aa0ba902b7",
    );
    expect(() => otel({ urlTemplate: "https://x/no-id" })).toThrow();
  });

  it("langsmith: org/project run URL keyed by the trace id as a UUID", () => {
    expect(langsmith({ org: "org-1", project: "proj-2" }).link(ctx)).toBe(
      "https://smith.langchain.com/o/org-1/projects/p/proj-2/r/4bf92f35-77b3-4da6-a3ce-929d0e0e4736?trace_id=4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
    );
  });

  it("langfuse: host/project/traces/{trace_id}?observation={span_id}", () => {
    expect(langfuse({ host: "https://lf.example.com/", project: "p1" }).link(ctx)).toBe(
      "https://lf.example.com/project/p1/traces/4bf92f3577b34da6a3ce929d0e0e4736?observation=00f067aa0ba902b7",
    );
  });

  it("openaiTraces: platform trace view with the trace_ prefix", () => {
    expect(openaiTraces().link(ctx)).toBe("https://platform.openai.com/traces/trace?trace_id=trace_4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("collects links, skips a throwing plugin, and formats a W3C traceparent", () => {
    const links = collectTraceLinks([openaiTraces(), { system: "broken", link: () => { throw new Error("x"); } }], ctx);
    expect(links.map((l) => l.system)).toEqual(["openai"]);
    expect(formatTraceparent(ctx)).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(w3cToUuid(ctx.trace_id)).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });
});
