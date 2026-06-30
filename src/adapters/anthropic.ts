import type { EnforcerFn } from "../types.js";

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  execute?: (input: Record<string, unknown>) => Promise<unknown>;
  [key: string]: unknown;
}

export function wrapAll(tools: unknown[], enforcer: EnforcerFn): unknown[] {
  return tools.map((tool) => {
    const t = tool as AnthropicTool;
    if (typeof t.execute !== "function") return tool;
    const origExec = t.execute;
    return {
      ...t,
      execute: async (input: Record<string, unknown>) => {
        return enforcer(t.name, input ?? {}, () => origExec(input));
      },
    };
  });
}
