// receipts.ts — Prompt 3 wiring: emit one AERF receipt per hardened/shaped run
// and verify the evidence layer, proving the cost-reduction layer and the
// evidence layer run together without either breaking the other.
//
// Pure and fast. The caller runs everything here AFTER a completion returns —
// never inside the model request path — so the model runs are not slowed.
//
// Note: a persisted AERF record (buildRecord) intentionally omits the Merkle
// leaf preimages, so it can't be re-hashed from disk alone. Verification
// therefore runs against the LIVE hardened handle at emit time (still off the
// request path, using the shared logic in ../receipt-proof/verify-receipt.ts);
// summarizeReceipts is the aggregate pass over every emitted receipt afterward.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AERFRecord } from "../../src/index.ts";
import type { VerifyResult } from "../receipt-proof/verify-receipt.ts";

/** A hardened/shaped toolset's receipt + evidence-verification closures. */
export interface ReceiptSource {
  record(): AERFRecord;
  verify(): VerifyResult;
}

export interface ReceiptOutcome {
  file: string;
  arm: string;
  task: string;
  run: number;
  result: VerifyResult;
}

/** Write one AERF record to <dir>/<arm>-<task>-<run>.json and verify its evidence. */
export function emitReceipt(
  dir: string,
  arm: string,
  task: string,
  run: number,
  src: ReceiptSource,
): ReceiptOutcome {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${arm}-${task}-${run}.json`);
  writeFileSync(file, JSON.stringify(src.record(), null, 2) + "\n");
  return { file, arm, task, run, result: src.verify() };
}

export interface ReceiptSummary {
  emitted: number;
  verified: number;
  tamperChecks: "PASS" | "FAIL";
  line: string;
  byArm: Record<string, { emitted: number; verified: number }>;
}

/** Post-benchmark pass over every emitted receipt: count how many verify. */
export function summarizeReceipts(outcomes: ReceiptOutcome[]): ReceiptSummary {
  const byArm: Record<string, { emitted: number; verified: number }> = {};
  let verified = 0;
  for (const o of outcomes) {
    const a = (byArm[o.arm] ??= { emitted: 0, verified: 0 });
    a.emitted++;
    if (o.result.allPass) {
      a.verified++;
      verified++;
    }
  }
  const emitted = outcomes.length;
  // Tamper checks PASS iff every emitted receipt verified end to end (root
  // reconstructs, proof validates, and single-field tampering is detected).
  const tamperChecks: "PASS" | "FAIL" =
    emitted > 0 && verified === emitted ? "PASS" : "FAIL";
  const line = `Receipts emitted: ${emitted}. Verified: ${verified}. Tamper checks: ${tamperChecks}.`;
  return { emitted, verified, tamperChecks, line, byArm };
}

/** Write the machine-readable summary for compare3.ts / cross-model diffing. */
export function writeReceiptsSummary(outDir: string, summary: ReceiptSummary): void {
  writeFileSync(
    join(outDir, "receipts-summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
}

/**
 * Insert or update the single "Receipts emitted: …" line in RESULTS.md without
 * clobbering anything else (compare3.ts --md may own the rest of the file).
 * Creates a minimal RESULTS.md if none exists yet.
 */
export function upsertReceiptsLine(resultsPath: string, line: string): void {
  let body = "";
  try {
    body = readFileSync(resultsPath, "utf8");
  } catch {
    /* new file */
  }
  const marker = /^Receipts emitted:.*$/m;
  if (marker.test(body)) {
    body = body.replace(marker, line);
  } else if (body.trim().length > 0) {
    body = body.replace(/\s*$/, "") + "\n\n" + line + "\n";
  } else {
    body = `# AgentMint diagnostic — results\n\n${line}\n`;
  }
  writeFileSync(resultsPath, body);
}
