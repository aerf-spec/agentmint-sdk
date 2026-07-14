// npm run demo:tamper
//
// A scripted agent session, each decision captured as a signed, hash-chained
// receipt. The full chain verifies — then we flip one byte of a receipt's
// action field and the signature over that receipt no longer holds. Tamper is
// detectable, and we can name exactly which receipt broke.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDecisionReceipts } from "../../src/receipt-decision.js";
import { runDemoSession, receiptLine } from "./session.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

async function main() {
  const { receipts, publicKeyPem, keyId, specHash } = await runDemoSession();

  console.log("\nAgentMint tamper demo");
  console.log("A signed receipt per decision; the chain proves the whole story.\n");
  console.log("  seq  verdict  action            reason");
  console.log("  ───  ───────  ────────────────  ──────");
  for (const r of receipts) console.log(receiptLine(r));

  // Export for downstream (e.g. Go-verifier) compatibility testing.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "receipts.json"), JSON.stringify(receipts, null, 2));
  writeFileSync(join(outDir, "public_key.pem"), publicKeyPem);

  const before = verifyDecisionReceipts(receipts, publicKeyPem);
  if (!before.ok) {
    console.error(`\nUnexpected: fresh chain did not verify: ${before.reason}`);
    process.exit(1);
  }
  console.log(`\nChain verify: VALID, key_id: ${keyId}, spec_hash: ${specHash}`);

  // Flip one byte in receipt 2's action field (index 1).
  const target = receipts[1]!;
  const original = target.action;
  const flipped = "X" + original.slice(1);
  console.log(`\nTampering: flipping one byte of receipt 2's action ("${original}" → "${flipped}")...`);
  target.action = flipped;

  const after = verifyDecisionReceipts(receipts, publicKeyPem);
  if (after.ok) {
    console.error("\nUnexpected: tampered chain still verified!");
    process.exit(1);
  }
  console.log(`Chain verify: BROKEN at index ${after.brokenAt}`);
  console.log(`  ↳ ${after.reason}`);
  console.log("\nThe receipt was signed; changing it after the fact is caught.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
