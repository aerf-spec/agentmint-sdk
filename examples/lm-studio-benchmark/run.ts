// Hardened runner: identical tools + prompts to run-baseline.ts, but the tools
// are wrapped with AgentMint harden() + the benchmark spec. Run:  npx tsx run.ts
//
// Requires a live OpenAI-compatible server (LM Studio) at LM_STUDIO_URL.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { harden, loadSpec } from "../../src/index.ts";
import {
  createRawTools,
  priceOf,
  SPEC_YAML,
  type RunFile,
} from "./tools.js";
import { ALL_TASKS } from "./tasks/index.js";
import { makeClient, runTaskMedian, RUNS_PER_TASK, type ToolSet } from "./agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "analysis", "output");
const RESULTS_DIR = join(HERE, "results");
const MODEL = process.env.LM_STUDIO_MODEL ?? "qwen3.5-9b-mlx";
const DRY_RUN = process.argv.includes("--dry-run");

type HardenedTools = Record<string, (p: Record<string, unknown>) => Promise<unknown>> & {
  __state(): { blockedCount: number; totalCost: number; events: Array<{ result: string; reason?: string }> };
  __receipt(): string;
};

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // --dry-run: skip LM Studio entirely and replay the committed sample runs
  // into analysis/output/, so `compare` can render the table with no model.
  if (DRY_RUN) {
    for (const f of ["baseline.json", "hardened.json"]) {
      copyFileSync(join(RESULTS_DIR, f), join(OUT_DIR, f));
    }
    console.error(
      "\n  --dry-run: replayed committed sample runs into analysis/output/ " +
        "(no LM Studio call).\n  Run `npx tsx analysis/compare.ts` to see the table.\n",
    );
    return;
  }

  const rawLog = join(OUT_DIR, "hardened-raw.jsonl");
  writeFileSync(rawLog, ""); // fresh raw log for this run

  const spec = loadSpec(SPEC_YAML);
  const client = makeClient();

  console.log(`\n  AgentMint benchmark — HARDENED — model: ${MODEL}`);
  try {
    await client.models.list();
  } catch {
    console.error(
      `\n  ✗ Could not reach LM Studio at ${process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1"}.` +
        `\n    Start the LM Studio server and load ${MODEL} (or set LM_STUDIO_MODEL).\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`  Tasks: ${ALL_TASKS.length} · runs/task: ${RUNS_PER_TASK}\n`);

  const tasks = [];
  for (const task of ALL_TASKS) {
    const buildToolSet = (): ToolSet => {
      const h = harden(createRawTools(), {
        spec,
        silent: true,
        costEstimator: (tool: string) => priceOf(tool),
      }) as unknown as HardenedTools;
      return {
        fns: h,
        state: () => h.__state(),
        receipt: () => h.__receipt(),
      };
    };
    tasks.push(await runTaskMedian(client, MODEL, task, "hardened", buildToolSet, rawLog));
  }

  const out: RunFile = {
    model: MODEL,
    mode: "hardened",
    generatedAt: new Date().toISOString(),
    runsPerTask: RUNS_PER_TASK,
    tasks,
  };
  writeFileSync(join(OUT_DIR, "hardened.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n  Wrote analysis/output/hardened.json (${tasks.length} tasks)\n`);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("run.ts") || entry.endsWith("run.js")) {
  main().catch((err) => {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
