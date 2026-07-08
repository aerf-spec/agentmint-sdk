import { describe, expect, it, vi } from "vitest";
import { wrapAll as wrapVercel } from "./vercel.js";
import { harden } from "../harden.js";
import { enforce } from "../enforce.js";
import { createRunState } from "../../log.js";
import type { EnforcerFn } from "../../types.js";
import type { VercelToolCallOptions } from "../vercel/types.js";

describe("vercel adapter — options forwarding", () => {
  it("forwards ToolCallOptions to the wrapped execute", async () => {
    const seen = vi.fn();
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const wrapped = wrapVercel(
      {
        baz: {
          execute: async (input: unknown, options: VercelToolCallOptions) => {
            seen(input, options);
            return "real";
          },
          description: "test",
        },
      },
      enforcer,
    ) as {
      baz: { execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown> };
    };

    const options: VercelToolCallOptions = {
      toolCallId: "call_123",
      messages: [{ role: "user" }],
    };
    await wrapped.baz.execute({ x: 1 }, options);

    expect(seen).toHaveBeenCalledTimes(1);
    const [input, forwarded] = seen.mock.calls[0]!;
    expect(input).toEqual({ x: 1 });
    // the exact options object is forwarded untouched
    expect(forwarded).toBe(options);
    expect((forwarded as VercelToolCallOptions).toolCallId).toBe("call_123");
  });

  it("propagates abortSignal so a hanging tool can be cancelled", async () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    // A tool that never resolves on its own — only the abort signal ends it.
    const hangingTool = (_input: unknown, options: VercelToolCallOptions) =>
      new Promise<string>((resolve, reject) => {
        const signal = options.abortSignal;
        if (!signal) return; // hang forever if the signal was dropped
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const wrapped = wrapVercel(
      { hang: { execute: hangingTool } },
      enforcer,
    ) as {
      hang: (typeof hangingTool extends never ? never : {
        execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown>;
      });
    };

    const controller = new AbortController();
    const pending = wrapped.hang.execute({}, {
      toolCallId: "call_hang",
      abortSignal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow("aborted");
  });

  it("leaves tools without execute (provider-executed / client-side) untouched", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const providerTool = {
      type: "provider" as const,
      id: "vendor.web_search",
      description: "provider-executed",
    };
    const wrapped = wrapVercel({ web_search: providerTool }, enforcer);
    // same reference — passed through, not re-wrapped
    expect(wrapped.web_search).toBe(providerTool);
  });

  it("preserves the rest of the tool shape (description, inputSchema)", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const wrapped = wrapVercel(
      {
        foo: {
          description: "does foo",
          inputSchema: { type: "object" },
          execute: async () => "real",
        },
      },
      enforcer,
    ) as { foo: { description: string; inputSchema: unknown } };

    expect(wrapped.foo.description).toBe("does foo");
    expect(wrapped.foo.inputSchema).toEqual({ type: "object" });
  });

  it("passes toolCallId to the enforcer as meta", async () => {
    const seenMeta = vi.fn();
    const enforcer: EnforcerFn = async (_tool, _params, exec, meta) => {
      seenMeta(meta);
      return exec();
    };
    const wrapped = wrapVercel(
      { foo: { execute: async () => "real" } },
      enforcer,
    ) as { foo: { execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown> } };

    await wrapped.foo.execute({}, { toolCallId: "call_abc" });
    expect(seenMeta).toHaveBeenCalledWith({ toolCallId: "call_abc" });
  });

  it("omits meta when no toolCallId is present", async () => {
    const seenMeta = vi.fn();
    const enforcer: EnforcerFn = async (_tool, _params, exec, meta) => {
      seenMeta(meta);
      return exec();
    };
    const wrapped = wrapVercel(
      { foo: { execute: async () => "real" } },
      enforcer,
    ) as { foo: { execute: (i: unknown) => Promise<unknown> } };

    await wrapped.foo.execute({});
    expect(seenMeta).toHaveBeenCalledWith(undefined);
  });
});

describe("vercel adapter — toolCallId lands on the receipt event", () => {
  it("stamps callRef on the emitted event via the real enforce()", async () => {
    const state = createRunState({});
    const enforcer: EnforcerFn = (tool, params, exec, meta) =>
      enforce(tool, params, exec, {}, state, meta);

    const wrapped = wrapVercel(
      { lookup_order: { execute: async () => ({ ok: true }) } },
      enforcer,
    ) as {
      lookup_order: {
        execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown>;
      };
    };

    await wrapped.lookup_order.execute(
      { order_id: "ORD-1" },
      { toolCallId: "call_order_1" },
    );

    const event = state.events.find((e) => e.tool === "lookup_order");
    expect(event).toBeDefined();
    expect(event!.result).toBe("allowed");
    expect(event!.callRef).toBe("call_order_1");
  });

  it("stamps callRef on a blocked event too", async () => {
    const state = createRunState({ deny: ["issue_refund"] });
    const enforcer: EnforcerFn = (tool, params, exec, meta) =>
      enforce(tool, params, exec, { deny: ["issue_refund"] }, state, meta);

    const wrapped = wrapVercel(
      { issue_refund: { execute: async () => "should not run" } },
      enforcer,
    ) as {
      issue_refund: {
        execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown>;
      };
    };

    const result = await wrapped.issue_refund.execute(
      { amount: 50 },
      { toolCallId: "call_refund_9" },
    );
    expect(result).toMatchObject({ error: true, tool: "issue_refund" });

    const event = state.events.find((e) => e.tool === "issue_refund");
    expect(event!.result).toBe("blocked");
    expect(event!.callRef).toBe("call_refund_9");
  });
});

describe("harden() round-trip on an AI SDK-shaped ToolSet", () => {
  it("still sniffs Vercel-shaped tools and enforces them", async () => {
    const tools = {
      issue_refund: {
        description: "refund an order",
        inputSchema: { type: "object" },
        execute: async () => "real",
      },
    };
    const hardened = harden(tools, { deny: ["issue_refund"] }) as {
      issue_refund: {
        execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown>;
      };
    };

    const blocked = await hardened.issue_refund.execute(
      {},
      { toolCallId: "c1" },
    );
    expect(blocked).toMatchObject({ error: true, tool: "issue_refund" });
  });

  it("allows a Vercel tool through when not denied, forwarding options", async () => {
    const seen = vi.fn();
    const tools = {
      lookup_order: {
        inputSchema: { type: "object" },
        execute: async (input: unknown, options: VercelToolCallOptions) => {
          seen(options.toolCallId);
          return "real";
        },
      },
    };
    const hardened = harden(tools) as {
      lookup_order: {
        execute: (i: unknown, o: VercelToolCallOptions) => Promise<unknown>;
      };
    };

    await expect(
      hardened.lookup_order.execute({}, { toolCallId: "c2" }),
    ).resolves.toBe("real");
    expect(seen).toHaveBeenCalledWith("c2");
  });
});
