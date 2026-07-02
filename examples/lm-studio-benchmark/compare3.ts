// compare3.ts — aggregates every diag-<arm>.json present and renders the table
// plus pre-registered verdicts (PROTOCOL.md) and the H1/H8 side-hypotheses.
//
//   npx tsx compare3.ts                            # console table + verdicts
//   npx tsx compare3.ts --md                       # + analysis/output/RESULTS.md + results.json
//   PRICE_IN=3 PRICE_OUT=15 npx tsx compare3.ts    # $/M tokens (proxy)
//
// Dollars here are PROXY (local models have no invoice). Real dollars and the
// prompt-caching interaction come from the API phase.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagRun } from "./agent-diag.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "analysis", "output");
const PRICE_IN = Number(process.env.PRICE_IN ?? 3);
const PRICE_OUT = Number(process.env.PRICE_OUT ?? 15);
const MD = process.argv.includes("--md");

// Canonical task order so tables read the same across models/runs.
const CANON_TASKS = [
  "coding-agent",
  "scope-creep",
  "loop-trigger",
  "context-bloat",
  "linear-control",
];

interface ArmFile {
  armKey: string;
  baseArm: string;
  steering: boolean;
  runsPerTask: number;
  model: string;
  runs: DiagRun[];
}

interface Verdict {
  id: string;
  pass: boolean;
  detail: string;
}

interface ReceiptSummary {
  emitted: number;
  verified: number;
  tamperChecks: string;
  line: string;
}

function loadAll(): Record<string, ArmFile> {
  const out: Record<string, ArmFile> = {};
  for (const f of readdirSync(OUT_DIR)) {
    const m = /^diag-(.+)\.json$/.exec(f);
    if (!m || f.endsWith("-raw.jsonl")) continue;
    out[m[1]!] = JSON.parse(readFileSync(join(OUT_DIR, f), "utf8")) as ArmFile;
  }
  return out;
}

function loadReceipts(): ReceiptSummary | null {
  try {
    return JSON.parse(readFileSync(join(OUT_DIR, "receipts-summary.json"), "utf8")) as ReceiptSummary;
  } catch {
    return null;
  }
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

interface Agg {
  n: number;
  promptMed: number;
  promptMin: number;
  promptMax: number;
  outMed: number;
  reasonMed: number;
  usdMed: number;
  successRate: number;
  turnCapRate: number;
  callsMed: number;
  blockedMed: number;
  afterBlockMed: number;
  dedupMed: number;
}
function agg(runs: DiagRun[]): Agg {
  const p = runs.map((r) => r.promptTokens);
  return {
    n: runs.length,
    promptMed: median(p),
    promptMin: Math.min(...p),
    promptMax: Math.max(...p),
    outMed: median(runs.map((r) => r.completionTokens)),
    reasonMed: median(runs.map((r) => Math.round(r.reasoningCharsEst / 4))),
    usdMed: median(
      runs.map(
        (r) => (r.promptTokens * PRICE_IN + r.completionTokens * PRICE_OUT) / 1e6,
      ),
    ),
    successRate: runs.length ? runs.filter((r) => r.success).length / runs.length : 0,
    turnCapRate: runs.length ? runs.filter((r) => r.hitTurnCap).length / runs.length : 0,
    callsMed: median(runs.map((r) => r.totalToolCalls)),
    blockedMed: median(runs.map((r) => r.blockedCalls)),
    afterBlockMed: median(runs.filter((r) => r.blockedCalls > 0).map((r) => r.turnsAfterFirstBlock)),
    dedupMed: median(runs.map((r) => r.dedupHits)),
  };
}

/** Pre-registered T1-T4 verdicts + H1/H8 side-hypotheses (thresholds unchanged). */
function computeVerdicts(
  A: Record<string, Record<string, Agg>>,
  tasks: string[],
  keys: string[],
): Verdict[] {
  const has = (k: string) => keys.includes(k);
  const verdicts: Verdict[] = [];

  // Core shaping verdicts (need baseline/hardened/shaped).
  if (has("baseline") && has("hardened") && has("shaped")) {
    const bloat = A["context-bloat"];
    const ctrl = A["linear-control"];
    if (bloat) {
      const ratio = bloat.shaped!.promptMed / Math.max(1, bloat.baseline!.promptMed);
      verdicts.push({
        id: "T1 shaped <= 80% of baseline prompt tokens on context-bloat",
        pass: ratio <= 0.8,
        detail: `shaped/baseline = ${pct(ratio)}`,
      });
      const marg = (bloat.hardened!.promptMed - bloat.shaped!.promptMed) /
        Math.max(1, bloat.baseline!.promptMed);
      verdicts.push({
        id: "T4 shaping adds >=10pp beyond enforcement (context-bloat)",
        pass: marg >= 0.1,
        detail: `hardened->shaped = ${pct(marg)} of baseline`,
      });
    }
    let t2 = true;
    const d: string[] = [];
    for (const task of tasks) {
      const drop = A[task]!.hardened!.successRate - A[task]!.shaped!.successRate;
      if (drop > 0.1) t2 = false;
      d.push(`${task} ${pct(A[task]!.hardened!.successRate)}->${pct(A[task]!.shaped!.successRate)}`);
    }
    verdicts.push({ id: "T2 shaped success within 10pp of hardened (all tasks)", pass: t2, detail: d.join("  ") });
    if (ctrl) {
      const sav = 1 - ctrl.shaped!.promptMed / Math.max(1, ctrl.baseline!.promptMed);
      const sd = ctrl.hardened!.successRate - ctrl.shaped!.successRate;
      verdicts.push({
        id: "T3 linear-control sanity: savings <5% and success intact",
        pass: sav < 0.05 && sd <= 0.1,
        detail: `control savings ${pct(sav)}, success drop ${pct(sd)}`,
      });
    }
  }

  // ATTRIBUTION (info): split the two effects on prompt tokens, per task.
  //   enforcement effect = hardened - baseline  (guardrail/spec overhead)
  //   truncation effect  = shaped - hardened     (dedup/truncation shaping)
  // A task where shaped > hardened is a guardrail tax: shaping cost tokens
  // instead of saving them.
  if (has("baseline") && has("hardened") && has("shaped")) {
    const sgn = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
    const parts: string[] = [];
    const taxed: string[] = [];
    for (const task of tasks) {
      const enf = A[task]!.hardened!.promptMed - A[task]!.baseline!.promptMed;
      const trunc = A[task]!.shaped!.promptMed - A[task]!.hardened!.promptMed;
      parts.push(`${task} enf ${sgn(enf)} / trunc ${sgn(trunc)}`);
      if (A[task]!.shaped!.promptMed > A[task]!.hardened!.promptMed) taxed.push(task);
    }
    verdicts.push({
      id: "ATTRIBUTION enforcement (hardened-baseline) vs truncation (shaped-hardened) prompt-token delta per task",
      pass: true,
      detail: `${parts.join("  |  ")}  ||  guardrail tax (shaped>hardened): ${taxed.length ? taxed.join(", ") : "none"}`,
    });
  }

  // H8 reasoning: report share of output tokens spent thinking (baseline).
  if (has("baseline")) {
    const rs: number[] = [], os: number[] = [];
    for (const task of tasks) {
      rs.push(A[task]!.baseline!.reasonMed);
      os.push(A[task]!.baseline!.outMed);
    }
    const r = median(rs), o = median(os);
    const share = o ? r / o : 0;
    verdicts.push({
      id: "H8 reasoning-token share of completion (info, not pass/fail)",
      pass: true,
      detail: `~${pct(share)} of output tokens are <think> — suppressing on routine turns could cut output cost by roughly this much`,
    });
  }

  return verdicts;
}

const coreVerdicts = (verdicts: Verdict[]): Verdict[] =>
  verdicts.filter((v) => /^T[1-4]/.test(v.id));

/** Color helpers from src/cli/color.ts if they import cleanly; else identity. */
async function loadColor(): Promise<{ green: (s: string) => string; red: (s: string) => string }> {
  try {
    const c = (await import("../../src/cli/color.ts")) as {
      green: (s: string) => string;
      red: (s: string) => string;
    };
    return { green: c.green, red: c.red };
  } catch {
    const id = (s: string) => s;
    return { green: id, red: id };
  }
}

function buildMarkdown(
  model: string,
  files: Record<string, ArmFile>,
  tasks: string[],
  keys: string[],
  A: Record<string, Record<string, Agg>>,
  verdicts: Verdict[],
  receipts: ReceiptSummary | null,
): string {
  const L: string[] = [];
  L.push("# AgentMint diagnostic — RESULTS", "");
  L.push(`- Model: \`${model}\``);
  L.push(`- Generated: ${new Date().toISOString()}`);
  L.push(`- Runs per arm: ${keys.map((k) => `${k} ${files[k]!.runsPerTask}`).join(", ")}`);
  L.push(`- Proxy pricing: $${PRICE_IN}/M in, $${PRICE_OUT}/M out (NOT an invoice)`);
  if (receipts) L.push(`- ${receipts.line}`);
  L.push("");

  L.push("## Per-task / per-arm", "");
  L.push("| task | arm | promptTok (min–max) | out | reason | $prx | succ | cap | calls | blk | aftBlk | dedup |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const task of tasks) {
    for (const k of keys) {
      const a = A[task]![k]!;
      L.push(
        `| ${task} | ${k} | ${a.promptMed} (${a.promptMin}–${a.promptMax}) | ${a.outMed} | ` +
          `${a.reasonMed} | $${a.usdMed.toFixed(3)} | ${pct(a.successRate)} | ${pct(a.turnCapRate)} | ` +
          `${a.callsMed} | ${a.blockedMed} | ${a.afterBlockMed} | ${a.dedupMed} |`,
      );
    }
  }
  L.push("");

  L.push("## Verdicts", "");
  for (const v of verdicts) {
    L.push(`- **${v.pass ? "PASS" : "FAIL"}** ${v.id} — ${v.detail}`);
  }
  L.push("");

  const core = coreVerdicts(verdicts);
  if (core.length) {
    const passed = core.filter((v) => v.pass).length;
    const survives = core.every((v) => v.pass);
    L.push("## Summary", "");
    L.push(
      `Core verdicts T1–T4: ${passed}/${core.length} passed ` +
        `(${core.map((v) => `${v.id.slice(0, 2)} ${v.pass ? "PASS" : "FAIL"}`).join(", ")}). ` +
        `Shaping thesis ${survives ? "SURVIVES" : "DOES NOT SURVIVE"} on ${model}.`,
    );
    L.push("");
  }
  return L.join("\n");
}

async function main(): Promise<void> {
  const files = loadAll();
  const keys = Object.keys(files);
  if (!keys.length) {
    console.log("  No diag-*.json in analysis/output/. Run run-all.ts first.");
    return;
  }
  // Refuse to mix models: every loaded diag file must report the same model,
  // otherwise the table would silently average across families. Name the
  // mismatched files and bail instead of rendering.
  const byModel = new Map<string, string[]>();
  for (const k of keys) {
    const m = files[k]!.model;
    (byModel.get(m) ?? byModel.set(m, []).get(m)!).push(`diag-${k}.json`);
  }
  if (byModel.size > 1) {
    console.error("\n  x Refusing to render: analysis/output/ mixes multiple models.");
    for (const [m, fs] of byModel) {
      console.error(`      ${m}: ${fs.join(", ")}`);
    }
    console.error("    Clear analysis/output/ and re-run a single model.\n");
    process.exitCode = 1;
    return;
  }
  const model = files[keys[0]!]!.model;

  // Union of tasks across all arms, in canonical order (steer arms omit some).
  const present = new Set(Object.values(files).flatMap((f) => f.runs.map((r) => r.task)));
  const tasks = [
    ...CANON_TASKS.filter((t) => present.has(t)),
    ...[...present].filter((t) => !CANON_TASKS.includes(t)),
  ];

  const A: Record<string, Record<string, Agg>> = {};
  for (const task of tasks) {
    A[task] = {};
    for (const k of keys) {
      A[task]![k] = agg(files[k]!.runs.filter((r) => r.task === task));
    }
  }

  const verdicts = computeVerdicts(A, tasks, keys);
  const receipts = loadReceipts();
  const { green, red } = await loadColor();

  // ── Console table (plain) ────────────────────────────────────────
  console.log(`\n  AgentMint diagnostic — ${model}`);
  console.log(`  Proxy pricing: $${PRICE_IN}/M in, $${PRICE_OUT}/M out (NOT an invoice)\n`);

  const H =
    pad("task", 15) + pad("arm", 15) + pad("promptTok (min-max)", 24) +
    pad("out", 6) + pad("reason", 8) + pad("$prx", 8) + pad("succ", 7) +
    pad("cap", 6) + pad("calls", 7) + pad("blk", 5) + pad("aftBlk", 8) + "dedup";
  console.log("  " + H);
  console.log("  " + "-".repeat(H.length));
  for (const task of tasks) {
    for (const k of keys) {
      const a = A[task]![k]!;
      console.log(
        "  " + pad(task, 15) + pad(k, 15) +
        pad(`${a.promptMed} (${a.promptMin}-${a.promptMax})`, 24) +
        pad(String(a.outMed), 6) + pad(String(a.reasonMed), 8) +
        pad(`$${a.usdMed.toFixed(3)}`, 8) + pad(pct(a.successRate), 7) +
        pad(pct(a.turnCapRate), 6) + pad(String(a.callsMed), 7) +
        pad(String(a.blockedMed), 5) + pad(String(a.afterBlockMed), 8) +
        String(a.dedupMed),
      );
    }
    console.log("");
  }

  // ── Verdicts (PASS green / FAIL red on the console) ──────────────
  console.log("  Verdicts:");
  for (const v of verdicts) {
    const tag = v.pass ? green("PASS") : red("FAIL");
    console.log(`  ${tag}  ${v.id}`);
    console.log(`        ${v.detail}`);
  }

  const core = coreVerdicts(verdicts);
  if (core.length) {
    const allPass = core.every((v) => v.pass);
    console.log(
      `\n  ${allPass ? green("SHAPING THESIS SURVIVES") + " — proceed to Model 2, then the $100 API phase (caching on vs off)." : red("SHAPING THESIS DOES NOT SURVIVE") + " as-is — see PROTOCOL.md kill criteria before spending on APIs."}`,
    );
  }
  if (receipts) console.log(`\n  ${receipts.line}`);
  console.log("");

  // Zero-token guard.
  const anyBaseline = files["baseline"];
  if (anyBaseline && anyBaseline.runs.every((r) => r.promptTokens === 0)) {
    console.log("  WARNING: promptTokens all 0 — LM Studio did not return the usage field. Nothing above is a token measurement.\n");
  }

  // ── Markdown + machine-readable aggregates ───────────────────────
  if (MD) {
    const md = buildMarkdown(model, files, tasks, keys, A, verdicts, receipts);
    writeFileSync(join(OUT_DIR, "RESULTS.md"), md + "\n");
    const results = {
      model,
      generatedAt: new Date().toISOString(),
      priceIn: PRICE_IN,
      priceOut: PRICE_OUT,
      runsPerArm: Object.fromEntries(keys.map((k) => [k, files[k]!.runsPerTask])),
      tasks,
      arms: keys,
      aggregates: A,
      verdicts,
      thesisSurvives: core.length > 0 && core.every((v) => v.pass),
      receipts,
    };
    writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify(results, null, 2) + "\n");
    console.log(`  Wrote analysis/output/RESULTS.md and results.json\n`);
  }
}

main().catch((err) => {
  console.error(`\n  x ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
