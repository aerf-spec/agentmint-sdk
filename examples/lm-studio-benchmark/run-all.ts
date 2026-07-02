// run-all.ts — runs every locally-testable arm in one pass against LM Studio,
// capturing real usage tokens. Arms:
//   baseline            raw heavy tools
//   hardened            + enforcement (your spec)
//   hardened+steer      + H1 enriched block messages
//   shaped              + dedup/truncation shaping
//   shaped+steer        + shaping + H1
// H8 (reasoning tokens) is captured on every arm automatically.
//
//   cd examples/lm-studio-benchmark
//   npx tsx run-all.ts                              # baseline/hardened x5, shaped/steer x10
//   RUNS_BASELINE=10 RUNS_SHAPED=20 npx tsx run-all.ts
//   RUNS=3 npx tsx run-all.ts                       # override both counts
//   LM_STUDIO_MODEL=<name> npx tsx run-all.ts       # pick the model
//   ONLY=baseline,shaped npx tsx run-all.ts         # subset of arms
//
// Interleaves by task (outer) then arm (inner), writing analysis/output/
// diag-<arm>.json incrementally after each task so a mid-run crash keeps the
// data for finished tasks. Steer arms run only on blocking tasks. Also writes
// raw per-run records and, for enforced arms, one AERF receipt per run.

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harden,
  loadSpec,
  buildRecord,
  type AERFRecord,
  type AgentMintConfig,
} from "../../src/index.ts";
import { SPEC_YAML, priceOf } from "./tools.ts";
import { createHeavyTools } from "./tools-heavy.ts";
import { shapeTools, SHAPE_CFG } from "./shape.ts";
import { ALL_TASKS } from "./tasks/index.ts";
import { EXTRA_TASKS } from "./tasks-extra.ts";
import {
  makeClient,
  runSingleDiag,
  type Arm,
  type DiagRun,
  type DiagToolSet,
} from "./agent-diag.ts";
import { verifyHardenedRun, type VerifyResult } from "../receipt-proof/verify-receipt.ts";
import {
  emitReceipt,
  summarizeReceipts,
  writeReceiptsSummary,
  upsertReceiptsLine,
  type ReceiptOutcome,
} from "./receipts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "analysis", "output");
const MODEL = process.env.LM_STUDIO_MODEL ?? "qwen3.5-9b-mlx";
const TASKS = [...ALL_TASKS, ...EXTRA_TASKS];

// Tasks that actually trigger blocks — steer arms only run on these.
const BLOCKING_TASKS = new Set(["coding-agent", "scope-creep", "loop-trigger"]);

function envRuns(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw === undefined) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}
// Asymmetric run counts: baseline/hardened are cheaper (RUNS_BASELINE, default
// 5); shaped and every steer arm need more samples (RUNS_SHAPED, default 10). A
// single RUNS env, when set, overrides both.
const RUNS_OVERRIDE = process.env.RUNS !== undefined ? envRuns("RUNS", 5) : undefined;
const RUNS_BASELINE = RUNS_OVERRIDE ?? envRuns("RUNS_BASELINE", 5);
const RUNS_SHAPED = RUNS_OVERRIDE ?? envRuns("RUNS_SHAPED", 10);
function runsForArm(key: string): number {
  return key === "baseline" || key === "hardened" ? RUNS_BASELINE : RUNS_SHAPED;
}

// arm key -> { base arm for tools, steering on/off }
interface ArmSpec {
  key: string;
  base: Arm;
  steering: boolean;
}
const ALL_ARMS: ArmSpec[] = [
  { key: "baseline", base: "baseline", steering: false },
  { key: "hardened", base: "hardened", steering: false },
  { key: "hardened-steer", base: "hardened", steering: true },
  { key: "shaped", base: "shaped", steering: false },
  { key: "shaped-steer", base: "shaped", steering: true },
];

// Default arms are recentered on baseline/hardened/shaped — the steer variants
// are excluded from the default set (their code paths remain and are reachable
// only when explicitly named via ONLY=).
const DEFAULT_ARMS: ArmSpec[] = ALL_ARMS.filter((a) => !a.steering);
const only = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ARMS = only.length ? ALL_ARMS.filter((a) => only.includes(a.key)) : DEFAULT_ARMS;

// A DiagToolSet plus the receipt/evidence closures Prompt 3 needs. record() and
// verify() are present only for enforced arms (hardened/shaped); baseline omits
// them, so it emits no receipt.
interface DiagToolSetPlus extends DiagToolSet {
  record?: () => AERFRecord;
  verify?: () => VerifyResult;
}

function buildToolSet(base: Arm): DiagToolSetPlus {
  const heavy = createHeavyTools();

  if (base === "baseline") return { fns: heavy };

  // hardened + shaped share one config; shaped just wraps the tools with shaping
  // first. evidenceChain is on so each run carries a Merkle evidence chain — this
  // does not change enforcement, breakers, or budget in any way.
  const config: AgentMintConfig = {
    spec: loadSpec(SPEC_YAML),
    silent: true,
    evidenceChain: true,
    costEstimator: (tool: string) => priceOf(tool),
  };

  const shaped = base === "shaped" ? shapeTools(heavy, SHAPE_CFG) : null;
  const h = harden(shaped ? shaped.fns : heavy, config);

  const set: DiagToolSetPlus = {
    fns: h as unknown as DiagToolSet["fns"],
    state: () => h.__state(),
    receipt: () => h.__receipt(),
    record: () => {
      h.__receipt(); // mark the run completed before snapshotting the record
      return buildRecord(h.__state(), config);
    },
    verify: () => verifyHardenedRun(h),
  };
  if (shaped) set.shapeStats = shaped.stats;
  return set;
}

/** Serialize one arm's accumulated runs to diag-<arm>.json (full rewrite/merge). */
function writeArmFile(arm: ArmSpec, runs: DiagRun[]): void {
  writeFileSync(
    join(OUT_DIR, `diag-${arm.key}.json`),
    JSON.stringify(
      {
        model: MODEL,
        armKey: arm.key,
        baseArm: arm.base,
        steering: arm.steering,
        runsPerTask: runsForArm(arm.key),
        generatedAt: new Date().toISOString(),
        runs,
      },
      null,
      2,
    ) + "\n",
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  // Clear stale diag artifacts before writing anything this run: arm files
  // (diag-<arm>.json) and raw logs (diag-<arm>-raw.jsonl) left over from a
  // previous model or arm subset contaminate the next analysis if kept.
  let cleared = 0;
  for (const f of readdirSync(OUT_DIR)) {
    if (/^diag-/.test(f) && (f.endsWith(".json") || f.endsWith(".jsonl"))) {
      unlinkSync(join(OUT_DIR, f));
      cleared++;
    }
  }
  console.log(`  cleared ${cleared} stale files`);

  const client = makeClient();

  console.log(`\n  AgentMint diagnostic — model: ${MODEL}`);
  console.log(`  Arms: ${ARMS.map((a) => a.key).join(", ")}`);
  console.log(
    `  Runs/task: baseline & hardened ${RUNS_BASELINE}; shaped, shaped-steer, hardened-steer ${RUNS_SHAPED}`,
  );
  try {
    await client.models.list();
  } catch {
    console.error(
      `\n  x Could not reach LM Studio at ${
        process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1"
      }.\n    Start the server and load ${MODEL} (or set LM_STUDIO_MODEL).\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Warmup: one throwaway completion so first-task timings aren't skewed by the
  // model's initial load. Fired before the timer starts; failures are non-fatal.
  try {
    await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: "warmup" }],
      max_tokens: 1,
      temperature: 0,
    });
  } catch {
    /* non-fatal — the real runs will surface a genuine connection problem */
  }
  console.log("  warmup done");

  const RECEIPTS_DIR = join(OUT_DIR, "receipts");
  const outcomes: ReceiptOutcome[] = [];

  // Accumulate each arm's runs across tasks; truncate raw logs once up front.
  const runsByArm = new Map<string, DiagRun[]>();
  for (const arm of ARMS) {
    runsByArm.set(arm.key, []);
    writeFileSync(join(OUT_DIR, `diag-${arm.key}-raw.jsonl`), "");
  }

  const t0 = Date.now();
  // Outer loop = TASKS, inner = ARMS, so every diag-<arm>.json is complete for
  // all finished tasks even if a later task crashes.
  for (const task of TASKS) {
    const taskStart = Date.now();
    console.log(`\n  === TASK: ${task.name} ===`);
    for (const arm of ARMS) {
      if (arm.steering && !BLOCKING_TASKS.has(task.name)) {
        console.log(`  - ${arm.key}: skipped (non-blocking task)`);
        continue;
      }
      const runsN = runsForArm(arm.key);
      const rawLog = join(OUT_DIR, `diag-${arm.key}-raw.jsonl`);
      const armRuns = runsByArm.get(arm.key)!;
      process.stdout.write(`  > ${arm.key} `);
      for (let i = 1; i <= runsN; i++) {
        const toolset = buildToolSet(arm.base);
        const r = await runSingleDiag(client, toolset, task, {
          model: MODEL,
          arm: arm.base,
          rawLogPath: rawLog,
          runIndex: i,
          steering: arm.steering,
        });
        armRuns.push(r);
        // Prompt 3: for enforced (hardened/shaped) arms only, emit + verify one
        // AERF receipt per run — AFTER the completion returns, never in the
        // request path. Baseline exposes no record/verify, so it is skipped.
        if (toolset.record && toolset.verify) {
          outcomes.push(
            emitReceipt(RECEIPTS_DIR, arm.key, task.name, i, {
              record: toolset.record,
              verify: toolset.verify,
            }),
          );
        }
        process.stdout.write(r.success ? "." : "x");
      }
      process.stdout.write("\n");
      // Incremental write: this arm now holds every finished task's runs.
      writeArmFile(arm, armRuns);
    }
    const secs = ((Date.now() - taskStart) / 1000).toFixed(1);
    console.log(`  task ${task.name} done in ${secs}s`);
  }

  // Post-benchmark: verification pass over every emitted receipt, then record
  // the coexistence proof in RESULTS.md + a machine-readable summary.
  const summary = summarizeReceipts(outcomes);
  writeReceiptsSummary(OUT_DIR, summary);
  upsertReceiptsLine(join(OUT_DIR, "RESULTS.md"), summary.line);

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(
    `\n  Done in ${mins} min. Now run:  npx tsx compare3.ts --md\n` +
      `  '.' = task success, 'x' = task failure (watch the shaped arms).\n` +
      `  If promptTokens are all 0, LM Studio is not returning usage — fix that first.\n` +
      `\n  ${summary.line}\n` +
      `  ${summary.emitted} AERF receipts in analysis/output/receipts/ · summary in receipts-summary.json\n`,
  );
}

main().catch((err) => {
  console.error(`\n  x ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
