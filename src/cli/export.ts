// agentmint export — bundle receipts into a portable, self-verifying zip.
//
//   agentmint export --from receipts/ --out evidence.zip \
//       [--plan plan.json] [--key notary_key.pem | --pub public_key.pem] \
//       [--created 2026-07-15T00:00:00Z]
//
// --created pins the package_created timestamp in receipt_index.json, so the
// same receipts export to a byte-identical zip (deterministic regeneration).
//
// --from accepts a directory of receipt .json files and/or .jsonl files (one
// receipt per line, e.g. a FileReceiptSink output). Receipts are ordered by
// seq when present, else by observed_at.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPublicKey } from "node:crypto";
import { EvidencePackage } from "../evidence.js";
import { publicKeyToPem, privateKeyFromPem } from "../kernel/sign.js";
import type { AerfReceipt } from "../receipt-aerf.js";
import type { PlanReceipt } from "../plan.js";
import { fg, green, muted, red } from "./color.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadReceipts(fromDir: string): AerfReceipt[] {
  const receipts: AerfReceipt[] = [];
  for (const name of readdirSync(fromDir).sort()) {
    const path = join(fromDir, name);
    if (!statSync(path).isFile()) continue;
    if (name.endsWith(".jsonl")) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (line.trim()) receipts.push(JSON.parse(line) as AerfReceipt);
      }
    } else if (name.endsWith(".json") && name !== "plan.json" && name !== "receipt_index.json") {
      receipts.push(JSON.parse(readFileSync(path, "utf-8")) as AerfReceipt);
    }
  }
  receipts.sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0;
  });
  return receipts;
}

export async function runExport(): Promise<void> {
  const from = argValue("--from");
  const out = argValue("--out") ?? "evidence.zip";
  const planPath = argValue("--plan");
  const keyPath = argValue("--key");
  const pubPath = argValue("--pub");
  const created = argValue("--created");

  if (!from) {
    console.error(`\n  ${red("✗")} Usage: agentmint export --from receipts/ --out evidence.zip [--plan plan.json] [--key notary_key.pem | --pub public_key.pem]\n`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(from)) {
    console.error(`\n  ${red("✗")} No such directory: ${from}\n`);
    process.exitCode = 1;
    return;
  }

  const receipts = loadReceipts(from);
  if (receipts.length === 0) {
    console.error(`\n  ${red("✗")} No receipts found in ${from} (.json or .jsonl)\n`);
    process.exitCode = 1;
    return;
  }

  const plan = planPath
    ? (JSON.parse(readFileSync(planPath, "utf-8")) as PlanReceipt)
    : undefined;

  let publicKeyPem: string | undefined;
  let signingKey: string | undefined;
  if (keyPath) {
    signingKey = readFileSync(keyPath, "utf-8");
    publicKeyPem = publicKeyToPem(createPublicKey(privateKeyFromPem(signingKey)));
  } else if (pubPath) {
    publicKeyPem = readFileSync(pubPath, "utf-8");
  } else {
    // A default Notary stateDir keeps notary_key.pem next to the receipts.
    const sibling = join(from, "..", "notary_key.pem");
    const inside = join(from, "notary_key.pem");
    const found = [inside, sibling].find((p) => existsSync(p));
    if (found) {
      signingKey = readFileSync(found, "utf-8");
      publicKeyPem = publicKeyToPem(createPublicKey(privateKeyFromPem(signingKey)));
    }
  }
  if (!publicKeyPem) {
    console.error(`\n  ${red("✗")} Need the issuer key: pass --key notary_key.pem or --pub public_key.pem\n`);
    process.exitCode = 1;
    return;
  }

  const pkg = new EvidencePackage({ plan, publicKeyPem, signingKey, packageCreated: created });
  for (const r of receipts) pkg.add(r);
  const path = pkg.export(resolve(out));

  const summary = pkg.receipts.filter((r) => !r.in_policy).length;
  const zipName = out.split("/").pop() || out;
  console.log("");
  console.log(`  ${green("✓")} Exported ${fg(String(receipts.length))} receipt${receipts.length === 1 ? "" : "s"} to ${fg(path)}.`);
  if (summary > 0) console.log(`    ${muted(`${summary} out-of-policy receipt(s) are included and flagged in receipt_index.json.`)}`);
  console.log("");
  console.log(`  ${muted(`Next: send ${zipName} to your buyer. They verify with: unzip ${zipName} && node verify.mjs. They do not need agentmint installed.`)}`);
  console.log("");
}
