// npm run demo:rcm
//
// A prior authorization agent session under a signed plan. The agent may read
// one patient's records and submit prior auths; any appeal is a checkpoint a
// clinician has to clear. Each decision is an Ed25519-signed, hash-chained
// receipt. The chain verifies, then one flipped byte names the exact receipt
// that changed.
//
// This is the same scenario `agentmint demo` runs by default. Here we also
// export the chain so an auditor can verify it standalone.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRcmChain, renderRcmSession } from "../../src/cli/rcm.js";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

async function main(): Promise<void> {
  const chain = buildRcmChain();
  await renderRcmSession(chain);

  // Export the untouched chain for downstream verification.
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "receipts.json"), JSON.stringify(chain.receipts, null, 2));
  writeFileSync(join(outDir, "public_key.pem"), chain.publicKeyPem);
  writeFileSync(join(outDir, "plan.json"), JSON.stringify(chain.plan, null, 2));

  console.log(`  Wrote ${join("examples", "demos", "out")}/receipts.json and public_key.pem.`);
  console.log("  Next: verify the exported chain with");
  console.log("    agentmint verify --receipts examples/demos/out/receipts.json --pub examples/demos/out/public_key.pem");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
