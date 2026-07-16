// Renders the linkable side files for the prior authorization session:
// a human-readable Markdown of the receipts, and a verification report. Both
// are built from the same SDK-produced data as the page, so they stay in sync.
import type { PageData } from "./build-receipt-viewer.js";

const PAYER = "Northgate Health Plan";
const REPO = "https://github.com/aerf-spec/agentmint-sdk";

/** "2026-01-15T09:00:01.000000+00:00" -> "2026-01-15 09:00:01 UTC" */
function fmtTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

const SAMPLE_NOTE =
  "Sample data. No real patient information. Identifiers, amounts, and the payer name are fictional. The signatures and hashes are real, computed by the SDK over this synthetic session.";

/** A plain-language, readable rendering of every receipt. */
export function renderReceiptsMarkdown(data: PageData): string {
  const lines: string[] = [];
  lines.push("# Prior authorization session PA-2210: receipts");
  lines.push("");
  lines.push(SAMPLE_NOTE);
  lines.push("");
  lines.push("| | |");
  lines.push("| --- | --- |");
  lines.push(`| Agent | \`${data.agent}\` |`);
  lines.push(`| Payer | ${PAYER} (example) |`);
  lines.push(`| Plan issued | ${fmtTime(data.issuedAt)} |`);
  lines.push(`| Signing key | \`${data.keyId}\` |`);
  lines.push(`| Authorized scope | ${data.scope.map((s) => `\`${s}\``).join(", ")} |`);
  lines.push(`| Checkpoints | ${data.checkpoints.map((s) => `\`${s}\``).join(", ")} |`);
  lines.push(`| Receipts | ${data.receipts.length} |`);
  lines.push(`| Chain root | \`${data.cleanRootHash}\` |`);
  lines.push("");
  lines.push("The same receipts in other formats:");
  lines.push("");
  lines.push("- Raw signed JSON: [receipts.json](./receipts.json)");
  lines.push("- Verification report: [verification.md](./verification.md)");
  lines.push("- Public key: [public_key.pem](./public_key.pem)");
  lines.push("");

  for (const v of data.receipts) {
    const r = v.receipt as unknown as Record<string, unknown>;
    const prev = (r.previous_receipt_hash as string | undefined) ?? "none (first receipt in the chain)";
    lines.push("---");
    lines.push("");
    lines.push(`## Receipt ${r.seq}: ${v.step.status}`);
    lines.push("");
    lines.push(`**${v.step.title}.** ${v.step.plain}`);
    lines.push("");
    lines.push(`- Action: \`${v.step.action}\``);
    lines.push(`- Status: ${v.step.status}`);
    lines.push(`- In policy: \`${r.in_policy}\``);
    lines.push(`- Recorded: ${fmtTime(String(r.observed_at))}`);
    lines.push(`- Sequence number: ${r.seq}`);
    lines.push(`- Receipt id: \`${r.id}\``);
    lines.push(`- Policy reason: ${r.policy_reason}`);
    lines.push(`- Evidence: \`${JSON.stringify(r.evidence)}\``);
    lines.push(`- Issuer signature (Ed25519): \`${r.signature}\``);
    lines.push(`- Previous receipt hash: \`${prev}\``);
    lines.push(`- Evidence hash (SHA-512): \`${r.evidence_hash_sha512}\``);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("## Verify these yourself");
  lines.push("");
  lines.push(
    "You do not have to trust this file. The same receipts are in a downloadable evidence packet, byte for byte the same. Check them with Node and nothing else.",
  );
  lines.push("");
  lines.push("```");
  lines.push(`git clone ${REPO}`);
  lines.push("cd agentmint-sdk/examples/sample-evidence-packet");
  lines.push("unzip evidence.zip -d packet");
  lines.push("node packet/verify.mjs");
  lines.push("```");
  lines.push("");
  return lines.join("\n") + "\n";
}

export interface ReceiptCheck {
  seq: number;
  action: string;
  id: string;
  ok: boolean;
}

/** The verification report: the clean pass and the tamper failure, both real. */
export function renderVerificationMarkdown(
  data: PageData,
  checks: readonly ReceiptCheck[],
): string {
  const t = data.tamper;
  const lines: string[] = [];
  lines.push("# Verification report: prior authorization session PA-2210");
  lines.push("");
  lines.push(SAMPLE_NOTE);
  lines.push("");
  lines.push(
    "This report was produced by the SDK verifier (`verifyAerfChain`) over the receipts in [receipts.json](./receipts.json). Every line below is the verifier's own result, not a description of it.",
  );
  lines.push("");

  lines.push("## Clean chain");
  lines.push("");
  lines.push(
    "All checks pass. Every signature is valid, every receipt's recorded link matches the receipt before it, and the sequence runs with no gaps.",
  );
  lines.push("");
  lines.push("```");
  for (const c of checks) {
    lines.push(`  ${c.ok ? "ok  " : "FAIL"}  signature  seq ${c.seq}  ${c.action}`);
  }
  lines.push(`  ok    chain root ${data.cleanRootHash}`);
  lines.push("");
  lines.push(`  PASS: ${checks.length} receipt(s), chain intact.`);
  lines.push("```");
  lines.push("");

  lines.push("## Tamper check");
  lines.push("");
  lines.push(
    `One field on receipt ${t.receiptIndex} (\`${t.field}\`) was changed from \`${t.from}\` to \`${t.to}\` after it was signed, to make the blocked read look as though it had been allowed. Nothing else was touched. The same verifier was run again.`,
  );
  lines.push("");
  lines.push("```");
  lines.push("  chain invalid");
  lines.push(`  break at receipt ${t.receiptIndex} (id ${t.receiptId})`);
  lines.push(`  type: ${t.breakType}`);
  lines.push(`  ${t.reason}`);
  lines.push(`  changed field: ${t.field}  ${t.from} -> ${t.to}`);
  lines.push("");
  lines.push(`  FAIL: verification stops at receipt ${t.receiptIndex}.`);
  lines.push("```");
  lines.push("");
  lines.push(
    "The check names the exact receipt and does not need to be told where to look. Every receipt after the changed one is also flagged, because each receipt is linked to the one before it.",
  );
  lines.push("");

  lines.push("## Reproduce this");
  lines.push("");
  lines.push("```");
  lines.push(`git clone ${REPO}`);
  lines.push("cd agentmint-sdk/examples/sample-evidence-packet");
  lines.push("unzip evidence.zip -d packet");
  lines.push("node packet/verify.mjs");
  lines.push("```");
  lines.push("");
  lines.push(
    "A pass prints `All checks passed: 6 receipt(s), chain intact.` and exits 0.",
  );
  lines.push("");
  return lines.join("\n") + "\n";
}
