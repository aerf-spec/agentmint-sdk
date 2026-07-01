import { enforce } from "./enforce.js";
import { formatReceipt } from "./receipt.js";
import { createRunState } from "./log.js";
import { validateGuardrails } from "./budget.js";
import { wrapAll as rawWrapAll } from "./adapters/raw.js";
import { wrapAll as openaiWrapAll } from "./adapters/openai.js";
import { wrapAll as anthropicWrapAll } from "./adapters/anthropic.js";
import { wrapAll as langchainWrapAll } from "./adapters/langchain.js";
import { wrapAll as vercelWrapAll } from "./adapters/vercel.js";
import type { AgentMintConfig, RunState, Event, EnforcerFn, MerkleProof } from "./types.js";

/** Built evidence chain handle, returned by __evidence() when evidenceChain is enabled */
export interface EvidenceChain {
  root: string;
  leafCount: number;
  getProof(index: number): MerkleProof;
}

export function harden<T extends Record<string, unknown> | unknown[]>(
  tools: T,
  config: AgentMintConfig = {},
): T & {
  __state(): RunState;
  __receipt(): string;
  __log(): Event[];
  __evidence(): EvidenceChain | null;
} {
  // Fail loudly at setup if budget guardrails are misconfigured, rather than
  // surfacing a confusing decision mid-run.
  validateGuardrails(config, config.spec);

  const state = createRunState(config);

  const enforcer: EnforcerFn = (tool, params, exec) =>
    enforce(tool, params, exec, config, state);

  let wrapped: unknown;

  if (Array.isArray(tools)) {
    const first = tools[0];
    if (first && typeof first === "object" && first !== null) {
      const f = first as Record<string, unknown>;
      // OpenAI: { function: { name, execute } }
      if (typeof (f.function as Record<string, unknown>)?.name === "string") {
        wrapped = openaiWrapAll(tools, enforcer);
      }
      // Anthropic: { name, input_schema }
      else if (typeof f.name === "string" && "input_schema" in f && typeof f.execute === "function") {
        wrapped = anthropicWrapAll(tools, enforcer);
      }
      // LangChain: { name, _call }
      else if (typeof f.name === "string" && typeof f._call === "function") {
        wrapped = langchainWrapAll(tools, enforcer);
      } else {
        wrapped = tools;
      }
    } else {
      wrapped = tools;
    }
  } else {
    const vals = Object.values(tools);
    const first = vals[0];
    if (
      first &&
      typeof first === "object" &&
      first !== null &&
      "execute" in (first as object)
    ) {
      wrapped = vercelWrapAll(tools as Record<string, { execute?: (...args: unknown[]) => Promise<unknown>; [key: string]: unknown }>, enforcer);
    } else {
      wrapped = rawWrapAll(tools as Record<string, (...args: unknown[]) => Promise<unknown>>, enforcer);
    }
  }

  Object.defineProperties(wrapped as object, {
    __state: {
      value: () => state,
      enumerable: false,
    },
    __receipt: {
      value: () => {
        if (state.status === "running") state.status = "completed";
        return formatReceipt(state, config);
      },
      enumerable: false,
    },
    __log: {
      value: () => state.events,
      enumerable: false,
    },
    __evidence: {
      value: (): EvidenceChain | null => {
        const tree = state.evidence;
        if (!tree) return null;
        const root = tree.build();
        return {
          root,
          leafCount: state.events.length,
          getProof: (index: number) => tree.getProof(index),
        };
      },
      enumerable: false,
    },
  });

  return wrapped as T & {
    __state(): RunState;
    __receipt(): string;
    __log(): Event[];
    __evidence(): EvidenceChain | null;
  };
}
