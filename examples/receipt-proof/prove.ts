// prove.ts — a fast, standalone proof that AgentMint's receipt / evidence layer
// does what it claims: signed, tamper-evident, and INDEPENDENTLY verifiable.
// No live model, no network, no third-party deps — runs in a few milliseconds.
//
//   cd examples/receipt-proof
//   npm run prove        # or: npx tsx prove.ts
//
// It hardens two trivial tools with a spec that blocks exactly one call, runs a
// scripted allowed → blocked → allowed sequence with evidenceChain enabled, then
// proves tamper-evidence deterministically against the honest Merkle root.
//
// The tamper-evidence checks live in ./verify-receipt.ts so the benchmark's
// post-run receipt-verification pass runs the exact same logic.
//
// Public-surface note: everything here uses only what src/index.ts already
// exports — harden(), buildRecord(), MerkleTree, canonicalize. A Merkle proof
// can be verified end to end from outside the SDK with no new export.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  harden,
  loadSpec,
  buildRecord,
  type AgentMintConfig,
  type AERFRecord,
} from "../../src/index.ts";
import { verifyHardenedRun, short, type VerifyResult } from "./verify-receipt.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "output");

// ── Trivial tool surface ───────────────────────────────────────────
// Nothing here is real. The MODEL is absent entirely; we script the calls.
type Tool = (params: Record<string, unknown>) => Promise<unknown>;

function createTools(): Record<string, Tool> {
  return {
    read_file: async (p) => ({ path: p.path, content: `// contents of ${String(p.path)}` }),
    send_email: async (p) => ({ to: p.to, sent: true }),
  };
}

// A spec that blocks exactly one thing: reading a .env file. One rule keeps the
// run deterministic — precisely one blocked event, so the proof is reproducible.
const SPEC_YAML = `
version: "1.1"
tools:
  read_file:
    input:
      properties:
        path:
          blocked_patterns: [".env"]
          action: block
`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const config: AgentMintConfig = {
    spec: loadSpec(SPEC_YAML),
    evidenceChain: true,
    silent: true,
  };
  const tools = harden(createTools(), config);

  // ── Scripted run: allowed → blocked → allowed ────────────────────
  await tools.read_file({ path: "README.md" }); // allowed
  await tools.read_file({ path: ".env" }); // blocked by the spec (never executes)
  await tools.send_email({ to: "ops@example.com" }); // allowed

  // ── Artifacts: the human receipt + the machine AERF record ───────
  const receiptText = tools.__receipt();
  const record = buildRecord(tools.__state(), config);
  writeFileSync(join(OUT_DIR, "receipt.txt"), receiptText + "\n");
  writeFileSync(join(OUT_DIR, "receipt.json"), JSON.stringify(record, null, 2) + "\n");

  // ── Tamper-evidence proof (shared logic) ─────────────────────────
  const result = verifyHardenedRun(tools);

  printReport(receiptText, record, result);
  writeProofMd(result, record);

  process.exitCode = result.allPass ? 0 : 1;
}

function printReport(receiptText: string, record: AERFRecord, result: VerifyResult): void {
  console.log("\n" + receiptText + "\n");
  console.log(
    `  Run ${record.runId} — ${record.summary.calls} calls, ` +
      `${record.summary.executed} executed, ${record.summary.blocked} blocked, ` +
      `${record.events.length} events in the evidence chain\n`,
  );
  console.log("  Receipt-layer proof (no model):");
  for (const c of result.checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`        ${c.detail}`);
  }
  console.log(`\n  Original root:  ${short(result.originalRoot)}`);
  console.log(`  Tampered root:  ${short(result.tamperedRoot)}`);
  console.log(
    `\n  ${
      result.allPass
        ? "A receipt plus its root detects single-field tampering: PASS"
        : "PROOF FAILED — at least one check did not hold. See output/PROOF.md."
    }`,
  );
  console.log(`\n  Wrote output/receipt.txt, output/receipt.json, output/PROOF.md\n`);
}

function writeProofMd(result: VerifyResult, record: AERFRecord): void {
  const lines: string[] = [
    "# AgentMint receipt proof",
    "",
    "Standalone, deterministic proof that the receipt / evidence layer is",
    "signed, tamper-evident, and independently verifiable. No model required;",
    "the whole thing runs in a few milliseconds.",
    "",
    "## What was tested",
    "",
    `A ${record.summary.calls}-call run (allowed → blocked → allowed) was wrapped`,
    "with `harden()` and `evidenceChain` enabled, producing an append-only Merkle",
    "evidence chain over its events. Using only the public SDK surface",
    "(`harden`, `buildRecord`, `MerkleTree`, `canonicalize`), the run's evidence",
    "root and a proof for the blocked call were verified from outside the SDK, then",
    "one event field was mutated in a copy of the log to show the root changes and",
    "verification fails.",
    "",
    "## Checks",
    "",
    ...result.checks.map(
      (c) => `- **${c.pass ? "PASS" : "FAIL"}** — ${c.name} (${c.detail})`,
    ),
    "",
    "## Roots (truncated)",
    "",
    `- Original root:  \`${short(result.originalRoot)}\``,
    `- Tampered root:  \`${short(result.tamperedRoot)}\``,
    "",
    "## Claim",
    "",
    `A receipt plus its root detects single-field tampering: ${result.allPass ? "PASS" : "FAIL"}`,
    "",
  ];
  writeFileSync(join(OUT_DIR, "PROOF.md"), lines.join("\n"));
}

main().catch((err) => {
  console.error(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
