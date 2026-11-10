import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  anthropicMap,
  decision,
  genericMap,
  openaiMap,
  traceCall,
  traceDownstream,
  traceLLM,
  traceTools,
  traceTurn,
  traced,
  routeTemplate,
  DecisionError,
  type CallHooks,
  type DecisionSpec,
  type ReceiptRequest,
  type Span,
} from "./trace.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function harness(extra: Partial<CallHooks> = {}) {
  const spans: Span[] = [];
  const signed: ReceiptRequest[] = [];
  const hooks: CallHooks = {
    sign: async (r) => {
      signed.push(r);
      return { ok: true };
    },
    onSpan: (s) => spans.push(s),
    ...extra,
  };
  return { spans, signed, hooks };
}

const SPEC: DecisionSpec = {
  schema: "test/v0",
  fields: { point: ["a", "b"], count: "int", ref: "id", note: "text", member_id: "id" },
  policy: { member_id: "hashed", note: "dropped" },
};

const anthropicRes = {
  id: "msg_1",
  _request_id: "req_A",
  model: "m-1",
  stop_reason: "tool_use",
  content: [
    { type: "thinking", thinking: "the member has two visits left under the calendar year limit" },
    { type: "text", text: "Two visits." },
    { type: "tool_use", id: "t1", name: "lookup", input: { q: 1 } },
  ],
};

function expectValidStack(stack: ReceiptRequest["stack"]) {
  const ids = new Set(stack.map((s) => s.span_id));
  const roots = stack.filter((s) => s.parent_id === null);
  expect(roots.length).toBe(1);
  expect(roots[0]!.kind).toBe("turn");
  for (const s of stack) if (s.parent_id !== null) expect(ids.has(s.parent_id)).toBe(true);
  for (const s of stack) {
    expect(s.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(Number.isInteger(s.dur_us)).toBe(true);
  }
}

describe("traceLLM", () => {
  it("emits llm.request + llm.response, hashes thinking, captures tool_use and the request id", async () => {
    const h = harness();
    const client = { messages: { create: async (_req: unknown) => anthropicRes } };
    const llm = traceLLM(client, { method: "messages.create", map: anthropicMap });
    await traceCall(h.hooks, async (call) => {
      await traceTurn({ step: 0 }, () => llm.messages.create({ system: "secret prompt", messages: [] }));
      expect(call.requestIds).toEqual(["req_A"]);
      expect(call.counts.llm_calls).toBe(1);
    });
    const req = h.spans.find((s) => s.kind === "llm.request")!;
    const res = h.spans.find((s) => s.kind === "llm.response")!;
    expect(res.parent_id).toBe(req.span_id);
    expect(res.attrs.thinking_sha256).toBe(sha(anthropicRes.content[0]!.thinking!));
    expect(res.attrs.tool_calls).toEqual(["lookup"]);
    expect(res.attrs.request_id).toBe("req_A");
    expect(JSON.stringify(h.spans)).not.toContain("calendar year limit");
    expect(JSON.stringify(h.spans)).not.toContain("secret prompt");
  });

  it("is a pass-through outside a traced call", async () => {
    const llm = traceLLM({ messages: { create: async () => anthropicRes } });
    expect(await llm.messages.create()).toBe(anthropicRes);
  });

  it("maps OpenAI chat-completions and Responses shapes, and flat objects by default", () => {
    const chat = openaiMap({}, {
      id: "chatcmpl-1",
      model: "gpt-x",
      choices: [{ finish_reason: "tool_calls", message: { reasoning_content: "why", tool_calls: [{ function: { name: "f", arguments: '{"a":1}' } }] } }],
    });
    expect(chat).toMatchObject({ request_id: "chatcmpl-1", model: "gpt-x", thinking: "why", tool_calls: [{ name: "f", input: { a: 1 } }], stop_reason: "tool_calls" });
    const responses = openaiMap({}, {
      id: "resp_1",
      model: "gpt-y",
      status: "completed",
      output: [{ type: "reasoning", summary: [{ text: "because" }] }, { type: "function_call", name: "g", arguments: "{}" }],
    });
    expect(responses).toMatchObject({ request_id: "resp_1", thinking: "because", tool_calls: [{ name: "g", input: {} }] });
    expect(genericMap({}, anthropicRes).request_id).toBe("req_A");
    expect(genericMap({}, { request_id: "r9", thinking: "t", tool_calls: [{ name: "h", input: {} }] })).toMatchObject({ request_id: "r9", thinking: "t" });
  });

  it("records a timeout as an error span and an error receipt", async () => {
    const h = harness();
    const client = { messages: { create: async (_r?: unknown) => { throw Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }); } } };
    const llm = traceLLM(client);
    await traceCall(h.hooks, async () => {
      await expect(traceTurn({ step: 0 }, () => llm.messages.create({}))).rejects.toThrow(/timed out/);
    });
    const span = h.spans.find((s) => s.kind === "llm.request")!;
    expect(span.status).toBe("error");
    expect(span.error_kind).toBe("llm_timeout");
    expect(h.signed.map((s) => s.kind)).toEqual(["error"]);
    expect(h.signed[0]!.error).toMatchObject({ kind: "llm_timeout", attempt: 1 });
    expectValidStack(h.signed[0]!.stack);
  });
});

describe("traceTools / traceDownstream", () => {
  it("nests tool.dispatch > tool.exec > downstream.call and adds tool.result", async () => {
    const h = harness();
    const api = traceDownstream("claims-api", {
      async get(path: string) {
        return { status: 200, body: { path } };
      },
    });
    const tools = traceTools({ lookup: async (i: { id: string }) => (await api.get(`/members/${i.id}`)).body });
    await traceCall(h.hooks, async (call) => {
      await traceTurn({ step: 0 }, () => tools.lookup({ id: "M1" }));
      expect(call.counts).toMatchObject({ tool_calls: 1, downstream_calls: 1 });
    });
    const by = (k: string) => h.spans.find((s) => s.kind === k)!;
    expect(by("tool.exec").parent_id).toBe(by("tool.dispatch").span_id);
    expect(by("downstream.call").parent_id).toBe(by("tool.exec").span_id);
    expect(by("tool.result").parent_id).toBe(by("tool.dispatch").span_id);
    expect(by("downstream.call").name).toBe("claims-api GET /members/M1");
    expect(by("downstream.call").public_name).toBe("claims-api GET /members/:id");
    expect(routeTemplate("/members/NH-552019/benefits?type=pt&year=2026")).toBe("/members/:id/benefits?…");
    expect(by("downstream.call").attrs).toMatchObject({ service: "claims-api", method: "GET", route: "/members/M1", status: 200 });
  });

  it("a throwing tool is an error span with attempt numbers, recorded once", async () => {
    const h = harness();
    let calls = 0;
    const tools = traceTools({
      flaky: async (_i: unknown) => {
        if (++calls === 1) throw new Error("boom");
        return { ok: true };
      },
    });
    await traceCall(h.hooks, async () => {
      await traceTurn({ step: 0 }, async () => {
        await expect(tools.flaky({})).rejects.toThrow("boom");
        await tools.flaky({});
      });
    });
    const execs = h.spans.filter((s) => s.kind === "tool.exec");
    expect(execs.map((s) => [s.status, s.attempt])).toEqual([["error", 1], ["ok", 2]]);
    expect(execs[0]!.error_kind).toBe("tool_error");
    expect(h.signed.filter((s) => s.kind === "error")).toHaveLength(1);
  });

  it("rejects malformed tool input", async () => {
    const h = harness();
    const tools = traceTools({ t: async (_i: unknown) => 1 });
    await traceCall(h.hooks, async () => {
      await expect(traceTurn({ step: 0 }, () => tools.t("nope" as never))).rejects.toThrow(/input must be an object/);
    });
    expect(h.signed[0]!.error?.kind).toBe("malformed_tool_input");
  });

  it("wraps object-style requests and only the listed methods", async () => {
    const h = harness();
    const client = traceDownstream("um-task-api", {
      async request(r: { method: string; path: string }) {
        return { status: 201, r };
      },
      async other() {
        return 1;
      },
    }, { methods: ["request"] });
    await traceCall(h.hooks, async () => {
      await traceTurn({ step: 0 }, async () => {
        await client.request({ method: "post", path: "/tasks" });
        await client.other();
      });
    });
    const calls = h.spans.filter((s) => s.kind === "downstream.call");
    expect(calls.map((s) => s.name)).toEqual(["um-task-api POST /tasks"]);
  });
});

describe("@traced (TC39 decorator)", () => {
  it("wraps a class method in a span on the same core", async () => {
    const h = harness();
    class Agent {
      constructor(readonly n: number) {}
      @traced("agent.plan")
      async plan(x: number) {
        return x + this.n;
      }
    }
    let out = 0;
    await traceCall(h.hooks, async () => {
      out = await traceTurn({ step: 0 }, () => new Agent(2).plan(3));
    });
    expect(out).toBe(5);
    const s = h.spans.find((x) => x.kind === "agent.plan")!;
    expect(s.name).toBe("plan");
    expect(s.parent_id).toBe(h.spans.find((x) => x.kind === "turn")!.span_id);
  });
});

describe("decision()", () => {
  it("validates, applies field policy, and issues the step receipt over a single-root stack", async () => {
    const h = harness();
    const tools = traceTools({ t: async (_i: unknown) => ({ ok: true }) });
    await traceCall(h.hooks, async () => {
      await traceTurn({ step: 3 }, async () => {
        await tools.t({});
        await decision({ point: "a", count: 2, ref: "R-1", note: "free text", member_id: "NH-1" }, SPEC);
      });
    });
    expect(h.signed).toHaveLength(1);
    const r = h.signed[0]!;
    expect(r.kind).toBe("decision");
    expect(r.record).toMatchObject({ schema: "test/v0", point: "a", count: 2, ref: "R-1" });
    expect(r.record).not.toHaveProperty("note");
    const hashed = (r.record!.member_id as { sha256: string }).sha256;
    expect(hashed).toBe(sha(`${r.salt}:"NH-1"`));
    expectValidStack(r.stack);
    expect(r.stack.map((s) => s.kind)).toEqual(["turn", "tool.dispatch", "tool.exec", "tool.result", "decision"]);
    // The turn root is closed (finished) when the receipt is issued.
    expect(r.stack[0]!.status).toBe("ok");
  });

  it("rejects decimals, unknown enums and unknown fields, and records the rejection", async () => {
    for (const bad of [
      { point: "a", count: 1.5, ref: "x", note: "", member_id: "m" },
      { point: "zzz", count: 1, ref: "x", note: "", member_id: "m" },
      { point: "a", count: 1, ref: "x", note: "", member_id: "m", extra: 1 },
      { point: "a", count: 1, ref: "has spaces", note: "", member_id: "m" },
    ]) {
      const h = harness();
      await traceCall(h.hooks, async () => {
        await expect(traceTurn({ step: 0 }, () => decision(bad, SPEC))).rejects.toBeInstanceOf(DecisionError);
      });
      expect(h.signed.map((s) => [s.kind, s.error?.kind])).toEqual([["error", "invalid_decision"]]);
    }
  });

  it("leak scan: a visible field sharing a 6-gram with raw thinking is blocked (fail closed)", async () => {
    const h = harness();
    const llm = traceLLM({ messages: { create: async (_r?: unknown) => anthropicRes } }, { map: anthropicMap });
    const spec: DecisionSpec = { schema: "leak/v0", fields: { point: ["a"], summary: "text" } };
    await traceCall(h.hooks, async () => {
      await expect(
        traceTurn({ step: 0 }, async () => {
          await llm.messages.create({ system: "Never read more than two numbers in one sentence please." });
          await decision({ point: "a", summary: "FYI the member has two visits left under the calendar cap" }, spec);
        }),
      ).rejects.toMatchObject({ kind: "leak_blocked" });
      // Prompt text is in the private corpus too.
      await expect(
        traceTurn({ step: 1 }, async () => decision({ point: "a", summary: "we never read more than two numbers in one sentence" }, spec)),
      ).rejects.toMatchObject({ kind: "leak_blocked" });
      // Unrelated text passes.
      await traceTurn({ step: 2 }, async () => decision({ point: "a", summary: "remaining visits stated, conflict flagged" }, spec));
    });
    expect(h.signed.map((s) => s.error?.kind ?? s.kind)).toEqual(["leak_blocked", "leak_blocked", "decision"]);
    expect(JSON.stringify(h.signed[0]!.error)).not.toContain("visits left");
  });

  it("claims: validated and passed through; cites must reference earlier claims", async () => {
    const claims = [
      { id: "c1", text: "private one", cites: [{ kind: "turn" as const, ref: "00:09" }] },
      { id: "c2", text: "private two", cites: [{ kind: "claim" as const, ref: "c1" }, { kind: "tool" as const, ref: "lookup.usage[1].visits" }] },
    ];
    const h = harness({ claims: () => claims });
    const spec: DecisionSpec = { schema: "c/v0", fields: { point: ["a"] } };
    await traceCall(h.hooks, async () => {
      await traceTurn({ step: 0 }, () => decision({ point: "a" }, spec));
    });
    expect(h.signed[0]!.claims).toEqual(claims);
    const bad = harness({ claims: () => [{ id: "c1", text: "x", cites: [{ kind: "claim", ref: "c2" }] }] });
    await traceCall(bad.hooks, async () => {
      await expect(traceTurn({ step: 0 }, () => decision({ point: "a" }, spec))).rejects.toMatchObject({ kind: "invalid_decision" });
    });
  });

  it("must run inside a traced turn", async () => {
    await expect(decision({}, SPEC)).rejects.toThrow(/traceTurn/);
  });
});
