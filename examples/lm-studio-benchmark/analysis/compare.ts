// Reads the baseline + hardened run files and prints the README-ready comparison
// table to stdout (so it can be piped) and writes it to results/summary.md.
//
// Source: analysis/output/{baseline,hardened}.json (live runs). If those don't
// exist yet, it falls back to the committed sample runs in results/ — so
// `npx tsx analysis/compare.ts` works immediately after checkout.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface TaskMetrics {
  totalToolCalls: number;
  sensitiveFileAttempts: number;
  pushToMainAttempts: number;
  rmRfAttempts: number;
  refundWithoutLookupAttempts: number;
  loopsBroken: number;
  estimatedCostUsd: number;
  durationMs: number;
}
interface RunFile {
  model: string;
  tasks: TaskMetrics[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const OUTPUT_DIR = join(HERE, "output");
const RESULTS_DIR = join(ROOT, "results");

function loadRun(name: "baseline" | "hardened"): { run: RunFile; source: string } {
  const live = join(OUTPUT_DIR, `${name}.json`);
  const sample = join(RESULTS_DIR, `${name}.json`);
  const path = existsSync(live) ? live : sample;
  return { run: JSON.parse(readFileSync(path, "utf8")) as RunFile, source: path };
}

const sum = (tasks: TaskMetrics[], pick: (t: TaskMetrics) => number): number =>
  tasks.reduce((acc, t) => acc + pick(t), 0);

function pctDelta(baseline: number, hardened: number): string {
  if (baseline === 0) return hardened === 0 ? "0%" : "+∞%";
  const d = Math.round(((hardened - baseline) / baseline) * 100);
  return `${d > 0 ? "+" : ""}${d}%`;
}

function prettyModel(model: string): string {
  return model
    .split(/[-_]/)
    .map((t) => {
      if (/^qwen/i.test(t)) return "Qwen" + t.slice(4);
      if (/^\d+(\.\d+)?b$/i.test(t)) return t.toUpperCase();
      if (/^mlx$/i.test(t)) return "MLX";
      if (/^instruct$/i.test(t)) return "Instruct";
      return t;
    })
    .join("-");
}

function buildTable(): string {
  const { run: baseline } = loadRun("baseline");
  const { run: hardened } = loadRun("hardened");

  const b = baseline.tasks;
  const h = hardened.tasks;

  const bCalls = sum(b, (t) => t.totalToolCalls);
  const hCalls = sum(h, (t) => t.totalToolCalls);
  const pushes = sum(h, (t) => t.pushToMainAttempts);
  const envs = sum(h, (t) => t.sensitiveFileAttempts);
  const rmrf = sum(h, (t) => t.rmRfAttempts);
  const refunds = sum(h, (t) => t.refundWithoutLookupAttempts);
  const loops = sum(h, (t) => t.loopsBroken);
  const bCost = sum(b, (t) => t.estimatedCostUsd);
  const hCost = sum(h, (t) => t.estimatedCostUsd);
  const bDur = sum(b, (t) => t.durationMs);
  const hDur = sum(h, (t) => t.durationMs);

  const model = prettyModel(hardened.model || baseline.model);
  const lines = [
    `## AgentMint vs. Baseline — ${model} (LM Studio)`,
    "",
    "| Metric | Without AgentMint | With AgentMint | Delta |",
    "|---|---|---|---|",
    `| Total tool calls | ${bCalls} | ${hCalls} | ${pctDelta(bCalls, hCalls)} |`,
    `| Pushes to main blocked | 0 caught | ${pushes} blocked | +${pushes} |`,
    `| .env reads blocked | 0 caught | ${envs} blocked | +${envs} |`,
    `| rm -rf attempts blocked | 0 caught | ${rmrf} blocked | +${rmrf} |`,
    `| Refund without lookup | 0 caught | ${refunds} blocked | +${refunds} |`,
    `| Retry loops broken | 0 caught | ${loops} broken | +${loops} |`,
    `| Estimated cost ($) | $${bCost.toFixed(2)} | $${hCost.toFixed(2)} | ${pctDelta(bCost, hCost)} |`,
    `| Duration (ms) | ${bDur} | ${hDur} | ${pctDelta(bDur, hDur)} |`,
  ];
  return lines.join("\n") + "\n";
}

const MARKDOWN_ONLY = process.argv.includes("--markdown");
const table = buildTable();

// stdout = only the table (pipe-friendly). In --markdown mode, emit nothing but
// the table — no stderr note either — so it appends cleanly into a README.
process.stdout.write(table);

const summaryPath = join(RESULTS_DIR, "summary.md");
writeFileSync(summaryPath, table);
if (!MARKDOWN_ONLY) process.stderr.write(`\n(wrote ${summaryPath})\n`);
