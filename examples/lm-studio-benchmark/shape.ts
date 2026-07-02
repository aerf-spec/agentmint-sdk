// shape.ts — harness-level prototype of tool-output shaping (dedup + truncation).
// Prototypes the SDK feature WITHOUT touching src/. If numbers hold, it moves
// into enforce.ts. Savings counted here are chars-not-emitted at the tool
// boundary; the REAL measure is the usage-token delta in agent-diag.ts, because
// every char a tool emits is re-sent on every later turn.

export interface ShapeToolConfig {
  dedup?: boolean;
  maxResultChars?: number;
}
export interface ShapeConfig {
  tools: Record<string, ShapeToolConfig>;
}
export interface ShapeStats {
  dedupHits: number;
  truncations: number;
  savedCharsDedup: number;
  savedCharsTrunc: number;
}

type Tool = (p: Record<string, unknown>) => Promise<unknown>;

function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return (
    "{" +
    Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canon((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

export function shapeTools(
  raw: Record<string, Tool>,
  cfg: ShapeConfig,
): { fns: Record<string, Tool>; stats: () => ShapeStats } {
  const seen = new Map<string, { callIndex: number; size: number }>();
  let callIndex = 0;
  const stats: ShapeStats = {
    dedupHits: 0,
    truncations: 0,
    savedCharsDedup: 0,
    savedCharsTrunc: 0,
  };

  const fns: Record<string, Tool> = {};
  for (const [name, fn] of Object.entries(raw)) {
    fns[name] = async (params) => {
      const t = cfg.tools[name];

      if (t?.dedup) {
        const key = name + "|" + canon(params);
        const prior = seen.get(key);
        if (prior) {
          stats.dedupHits++;
          const marker = {
            unchanged: true,
            ref: `${name}#${prior.callIndex}`,
            note:
              `Identical ${name} call already made this run and the result has ` +
              `not changed. Use the earlier result. Do not repeat this call.`,
          };
          stats.savedCharsDedup += Math.max(
            0,
            prior.size - JSON.stringify(marker).length,
          );
          return marker;
        }
      }

      let result = await fn(params);
      let s = JSON.stringify(result) ?? "";

      if (t?.maxResultChars && s.length > t.maxResultChars) {
        stats.truncations++;
        stats.savedCharsTrunc += s.length - t.maxResultChars;
        result = {
          truncated: true,
          content: s.slice(0, t.maxResultChars),
          note:
            `Result truncated at ${t.maxResultChars} chars by policy (original ` +
            `~${s.length}). Narrow the request if more is needed.`,
        };
        s = JSON.stringify(result) ?? "";
      }

      callIndex++;
      if (t?.dedup) {
        seen.set(name + "|" + canon(params), { callIndex, size: s.length });
      }
      return result;
    };
  }
  return { fns, stats: () => ({ ...stats }) };
}

export const SHAPE_CFG: ShapeConfig = {
  tools: {
    read_file: { dedup: true, maxResultChars: 6000 },
    search_web: { dedup: true, maxResultChars: 1500 },
    lookup_order: { dedup: true },
  },
};
