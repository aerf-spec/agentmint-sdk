import { describe, expect, it, vi } from "vitest";
import { wrapAll as wrapAnthropic } from "./anthropic.js";
import { watchTool } from "./generic.js";
import { wrapAll as wrapLangChain } from "./langchain.js";
import { wrapAll as wrapOpenAI } from "./openai.js";
import { wrapAll as wrapRaw } from "./raw.js";
import { wrapAll as wrapVercel } from "./vercel.js";
import { harden } from "../harden.js";
import type { EnforcerFn } from "../types.js";

describe("adapters", () => {
  it("raw_enforcement", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const wrapped = wrapRaw({ greet: async () => "hi" }, enforcer) as {
      greet: () => Promise<unknown>;
    };

    await expect(wrapped.greet()).resolves.toBe("intercepted");
  });

  it("raw_params", async () => {
    const seen = vi.fn();
    const enforcer: EnforcerFn = async (_tool, params, exec) => {
      seen(params);
      return exec();
    };
    const wrapped = wrapRaw({ greet: async (_params: unknown) => "hi" }, enforcer) as {
      greet: (params: Record<string, unknown>) => Promise<unknown>;
    };

    await wrapped.greet({ x: 1 });

    expect(seen).toHaveBeenCalledWith({ x: 1 });
  });

  it("openai_enforcement", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const tools = [{ function: { name: "foo", execute: async () => "real" } }];
    const wrapped = wrapOpenAI(tools, enforcer) as Array<{
      function: { name: string; execute: (args: unknown) => Promise<unknown> };
    }>;

    await expect(wrapped[0]!.function.execute({})).resolves.toBe("intercepted");
  });

  it("openai_preserves_schema", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const tools = [
      {
        function: {
          name: "foo",
          parameters: { type: "object" },
          execute: async () => "real",
        },
      },
    ];
    const wrapped = wrapOpenAI(tools, enforcer) as Array<{
      function: { name: string; parameters: unknown };
    }>;

    expect(wrapped[0]!.function.name).toBe("foo");
    expect(wrapped[0]!.function.parameters).toEqual({ type: "object" });
  });

  it("langchain_enforcement", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const tools = [{ name: "bar", _call: async () => "real" }];
    const wrapped = wrapLangChain(tools, enforcer) as Array<{
      _call: (input: unknown) => Promise<unknown>;
    }>;

    await expect(wrapped[0]!._call({})).resolves.toBe("intercepted");
  });

  it("langchain_preserves_name", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const tools = [{ name: "bar", _call: async () => "real" }];
    const wrapped = wrapLangChain(tools, enforcer) as Array<{ name: string }>;

    expect(wrapped[0]!.name).toBe("bar");
  });

  it("vercel_enforcement", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const wrapped = wrapVercel(
      {
        baz: {
          execute: async () => "real",
          description: "test",
        },
      },
      enforcer,
    ) as { baz: { execute: (params: Record<string, unknown>) => Promise<unknown> } };

    await expect(wrapped.baz.execute({})).resolves.toBe("intercepted");
  });

  it("anthropic_enforcement", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const tools = [
      { name: "foo", input_schema: { type: "object" }, execute: async () => "real" },
    ];
    const wrapped = wrapAnthropic(tools, enforcer) as Array<{
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    await expect(wrapped[0]!.execute({})).resolves.toBe("intercepted");
  });

  it("anthropic_passes_input_as_params", async () => {
    const seen = vi.fn();
    const enforcer: EnforcerFn = async (_tool, params, exec) => {
      seen(params);
      return exec();
    };
    const tools = [
      { name: "foo", input_schema: { type: "object" }, execute: async () => "real" },
    ];
    const wrapped = wrapAnthropic(tools, enforcer) as Array<{
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    await wrapped[0]!.execute({ order_id: "ORD-1" });
    expect(seen).toHaveBeenCalledWith({ order_id: "ORD-1" });
  });

  it("anthropic_preserves_schema", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const tools = [
      {
        name: "foo",
        description: "does foo",
        input_schema: { type: "object", properties: { x: { type: "string" } } },
        execute: async () => "real",
      },
    ];
    const wrapped = wrapAnthropic(tools, enforcer) as Array<{
      name: string;
      description: string;
      input_schema: unknown;
    }>;

    expect(wrapped[0]!.name).toBe("foo");
    expect(wrapped[0]!.description).toBe("does foo");
    expect(wrapped[0]!.input_schema).toEqual({
      type: "object",
      properties: { x: { type: "string" } },
    });
  });

  it("anthropic_leaves_tools_without_execute_untouched", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const tool = { name: "foo", input_schema: { type: "object" } };
    const wrapped = wrapAnthropic([tool], enforcer);
    expect(wrapped[0]).toBe(tool);
  });

  it("generic_watchTool", async () => {
    const enforcer: EnforcerFn = async () => "intercepted";
    const watched = watchTool("my_tool", async () => "real", enforcer);
    await expect(watched()).resolves.toBe("intercepted");
  });

  it("generic_preserves_name", () => {
    const enforcer: EnforcerFn = async (_tool, _params, exec) => exec();
    const watched = watchTool("my_tool", async () => "real", enforcer);
    expect(watched.name).toBe("my_tool");
  });

  it("generic_passes_single_object_arg_as_params", async () => {
    const seen = vi.fn();
    const enforcer: EnforcerFn = async (_tool, params, exec) => {
      seen(params);
      return exec();
    };
    const watched = watchTool("my_tool", async (..._args: unknown[]) => "real", enforcer);
    await watched({ amount: 30 });
    expect(seen).toHaveBeenCalledWith({ amount: 30 });
  });
});

describe("harden auto-detection", () => {
  it("detects Anthropic-shaped tools and enforces them", async () => {
    const tools = [
      { name: "foo", input_schema: { type: "object" }, execute: async () => "real" },
    ];
    const hardened = harden(tools, { deny: ["foo"] }) as Array<{
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    const blocked = await hardened[0]!.execute({});
    expect(blocked).toMatchObject({ error: true, tool: "foo" });
  });

  it("allows an Anthropic tool through when not denied", async () => {
    const tools = [
      { name: "foo", input_schema: { type: "object" }, execute: async () => "real" },
    ];
    const hardened = harden(tools) as Array<{
      execute: (input: Record<string, unknown>) => Promise<unknown>;
    }>;

    await expect(hardened[0]!.execute({})).resolves.toBe("real");
  });
});
