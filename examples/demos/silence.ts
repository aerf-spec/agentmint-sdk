// npm run demo:silence
//
// The same scripted session — but here the adversary does not MUTATE a receipt
// (which the tamper demo already catches). Instead they try to make a decision
// vanish: silently delete the receipt for the blocked transfer, hoping the gap
// goes unnoticed. It cannot. Each receipt commits to the previous one's hash,
// so a removed link leaves a hole the chain reports by index.
//
//   Logs can omit; chains cannot.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDecisionReceipts } from "../../src/receipt-decision.js";
import { runDemoSession, receiptLine } from "./session.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

async function main() {
  const { receipts, publicKeyPem, keyId, specHash } = await runDemoSession();

  console.log("\nAgentMint — silence demo");
  console.log("A decision was blocked. Can the agent hide that it ever happened?\n");
  console.log("  seq  verdict  action            reason");
  console.log("  ───  ───────  ────────────────  ──────");
  for (const r of receipts) console.log(receiptLine(r));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "receipts.json"), JSON.stringify(receipts, null, 2));
  writeFileSync(join(outDir, "public_key.pem"), publicKeyPem);

  const before = verifyDecisionReceipts(receipts, publicKeyPem);
  if (!before.ok) {
    console.error(`\nUnexpected: fresh chain did not verify — ${before.reason}`);
    process.exit(1);
  }
  console.log(`\nChain verify: VALID — key_id: ${keyId}, spec_hash: ${specHash}`);

  // Silently REMOVE the DENY receipt for the blocked transfer (index 1).
  const denyIdx = receipts.findIndex((r) => r.action === "transfer_funds");
  const withHole = [...receipts];
  const [removed] = withHole.splice(denyIdx, 1);
  console.log(
    `\nCover-up: silently deleting receipt ${removed!.seq} ` +
      `(DENY ${removed!.action}) from the exported array...`,
  );

  const after = verifyDecisionReceipts(withHole, publicKeyPem);
  if (after.ok) {
    console.error("\nUnexpected: the chain accepted a deleted decision!");
    process.exit(1);
  }
  console.log(`Chain verify: BROKEN at index ${after.brokenAt}`);
  console.log(`\n  ${after.reason}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
