// tools-heavy.ts — same tool surface as tools.ts but read-type tools return
// realistically sized outputs (~2-3K tokens/file) so context bloat can occur.
// The original mock read_file returns one line, which makes the shaping thesis
// structurally untestable. Content is deterministic per path so identical reads
// return identical bytes and dedup keys match.

import { createRawTools, isSensitivePath } from "./tools.ts";

type Tool = (params: Record<string, unknown>) => Promise<unknown>;

function hashN(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function bigFile(path: string): string {
  const h = hashN(path);
  const n = 60 + (h % 30);
  const out: string[] = [`// ${path} — module ${h % 997} (generated fixture)`];
  for (let i = 0; i < n; i++) {
    out.push(
      `export function fn_${h % 97}_${i}(a: number, b: number): number { ` +
        `const x = (a * ${i + 1}) + (b % ${1 + (h % 13)}); ` +
        `if (x > ${i * 3}) { return x - ${h % 29}; } ` +
        `return x + ${i}; } // handles case ${i} of ${path}`,
    );
  }
  return out.join("\n");
}

export function createHeavyTools(): Record<string, Tool> {
  const base = createRawTools();
  return {
    ...base,
    read_file: async (p) => {
      if (isSensitivePath(p.path)) return base.read_file!(p);
      return { path: p.path, content: bigFile(String(p.path)) };
    },
    search_web: async (p) => ({
      query: p.query,
      results: Array.from({ length: 8 }, (_, i) => ({
        title: `result-${i} for ${String(p.query)}`,
        url: `https://example.com/${hashN(String(p.query)) % 9999}/${i}`,
        snippet: `Snippet ${i}: ` + `lorem ipsum operational detail `.repeat(12).trim(),
      })),
    }),
  };
}
