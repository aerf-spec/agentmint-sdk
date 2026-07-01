// Baseline runner: identical tools + prompts to run.ts, but with NO harden() —
// the raw async tools run directly. Nothing is blocked; blockedCalls is always 0.
// We still tally sensitive-file / push-to-main / rm-rf / refund-without-lookup
// attempts by inspecting arguments, so the baseline shows what happened. Run:
//   tsx run-baseline.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRawTools, type RunFile } from "./tools.js";
import { ALL_TASKS } from "./tasks/index.js";
import { makeClient, runTaskMedian, RUNS_PER_TASK, type ToolSet } from "./agent.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "analysis", "output");
const MODEL = process.env.LM_STUDIO_MODEL ?? "qwen3.5-9b-mlx";

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const rawLog = join(OUT_DIR, "baseline-raw.jsonl");
  writeFileSync(rawLog, "");

  const client = makeClient();

  console.log(`\n  AgentMint benchmark — BASELINE (no harden) — model: ${MODEL}`);
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
    // No harden(): the raw tools ARE the toolset. No state/receipt.
    const buildToolSet = (): ToolSet => ({ fns: createRawTools() });
    tasks.push(await runTaskMedian(client, MODEL, task, "baseline", buildToolSet, rawLog));
  }

  const out: RunFile = {
    model: MODEL,
    mode: "baseline",
    generatedAt: new Date().toISOString(),
    runsPerTask: RUNS_PER_TASK,
    tasks,
  };
  writeFileSync(join(OUT_DIR, "baseline.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\n  Wrote analysis/output/baseline.json (${tasks.length} tasks)\n`);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("run-baseline.ts") || entry.endsWith("run-baseline.js")) {
  main().catch((err) => {
    console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
