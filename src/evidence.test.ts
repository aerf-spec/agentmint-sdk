// Evidence package: the exported zip must verify STANDALONE — extracted by an
// independent tool (Python zipfile) and checked by the bundled verify.mjs with
// no AgentMint code on the path.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notary } from "./notary.js";
import { EvidencePackage } from "./evidence.js";
import { verifyAerfReceipt } from "./receipt-aerf.js";
import { verifyPlan, type PlanReceipt } from "./plan.js";
import { crc32, buildZip } from "./kernel/zip.js";

const planInit = {
  user: "admin@example.com",
  action: "handle-claims",
  scope: ["submit:*", "read:*"],
};

function exportedPackage() {
  const notary = new Notary();
  const plan = notary.createPlan(planInit);
  notary.notarise({ action: "submit:claim:1", agent: "worker", plan, evidence: { n: 1 } });
  notary.notarise({ action: "read:report", agent: "worker", plan, evidence: { n: 2 } });
  notary.notarise({ action: "delete:all", agent: "worker", plan, evidence: { n: 3 } }); // out of policy
  return { notary, plan };
}

function extract(zipPath: string, destDir: string): void {
  const r = spawnSync("python3", ["-m", "zipfile", "-e", zipPath, destDir], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`zip extraction failed: ${r.stderr}`);
}

describe("kernel zip writer", () => {
  it("crc32 matches the known value for 'hello'", () => {
    expect(crc32(Buffer.from("hello")).toString(16)).toBe("3610a686");
  });

  it("python zipfile validates and round-trips the archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmint-zip-"));
    try {
      const zipPath = join(dir, "t.zip");
      writeFileSync(
        zipPath,
        buildZip([
          { name: "a.txt", content: "alpha" },
          { name: "sub/b.json", content: JSON.stringify({ b: 2 }) },
          { name: "run.sh", content: "#!/bin/sh\necho ok\n", mode: 0o755 },
        ]),
      );
      // testzip() returns the first bad entry or None; extraction must succeed.
      const check = spawnSync(
        "python3",
        ["-c", `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); bad=z.testzip(); sys.exit(1 if bad else 0)`, zipPath],
        { encoding: "utf-8" },
      );
      expect(check.status, check.stderr).toBe(0);
      extract(zipPath, join(dir, "out"));
      expect(readFileSync(join(dir, "out", "a.txt"), "utf-8")).toBe("alpha");
      expect(JSON.parse(readFileSync(join(dir, "out", "sub", "b.json"), "utf-8"))).toEqual({ b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("evidence package export", () => {
  it("exported zip verifies standalone: unzip → node verify.mjs → exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmint-evidence-"));
    try {
      const { notary, plan } = exportedPackage();
      const zipPath = await notary.exportEvidence(plan.id, join(dir, "evidence.zip"));
      const outDir = join(dir, "unpacked");
      extract(zipPath, outDir);

      // The full expected content set is present.
      const names = readdirSync(outDir).sort();
      expect(names).toEqual(["plan.json", "public_key.pem", "receipt_index.json", "receipts", "verify.mjs"]);
      expect(readdirSync(join(outDir, "receipts")).length).toBe(3);

      // Standalone verification with NO AgentMint code: bundled script only.
      const verify = spawnSync("node", ["verify.mjs"], { cwd: outDir, encoding: "utf-8" });
      expect(verify.status, verify.stdout + verify.stderr).toBe(0);
      expect(verify.stdout).toContain("All checks passed: 3 receipt(s), chain intact.");

      // Index carries the chain root, counts, and the flagged receipt.
      const index = JSON.parse(readFileSync(join(outDir, "receipt_index.json"), "utf-8"));
      expect(index.total_receipts).toBe(3);
      expect(index.in_policy_count).toBe(2);
      expect(index.out_of_policy_count).toBe(1);
      expect(index.chain.valid).toBe(true);
      expect(index.chain.root_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(index.chain.root_signature).toMatch(/^[0-9a-f]{128}$/);
      expect(index.merkle.root).toMatch(/^[0-9a-f]{64}$/);

      // Our own verifier also validates every extracted receipt + the plan.
      const pubPem = readFileSync(join(outDir, "public_key.pem"), "utf-8");
      const extractedPlan = JSON.parse(readFileSync(join(outDir, "plan.json"), "utf-8")) as PlanReceipt;
      expect(verifyPlan(extractedPlan, pubPem)).toBe(true);
      for (const f of readdirSync(join(outDir, "receipts"))) {
        const receipt = JSON.parse(readFileSync(join(outDir, "receipts", f), "utf-8"));
        expect(verifyAerfReceipt(receipt, { issuerPublicKey: pubPem }).ok).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the bundled verifier REJECTS a tampered receipt (exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmint-evidence-"));
    try {
      const { notary, plan } = exportedPackage();
      const zipPath = await notary.exportEvidence(plan.id, join(dir, "evidence.zip"));
      const outDir = join(dir, "unpacked");
      extract(zipPath, outDir);

      // Flip in_policy on one extracted receipt.
      const receiptsDir = join(outDir, "receipts");
      const victim = join(receiptsDir, readdirSync(receiptsDir)[0]!);
      const receipt = JSON.parse(readFileSync(victim, "utf-8"));
      receipt.in_policy = !receipt.in_policy;
      writeFileSync(victim, JSON.stringify(receipt, null, 2));

      const verify = spawnSync("node", ["verify.mjs"], { cwd: outDir, encoding: "utf-8" });
      expect(verify.status).toBe(1);
      expect(verify.stderr).toContain("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the bundled verifier REJECTS a deleted receipt (chain + seq)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmint-evidence-"));
    try {
      const { notary, plan } = exportedPackage();
      const zipPath = await notary.exportEvidence(plan.id, join(dir, "evidence.zip"));
      const outDir = join(dir, "unpacked");
      extract(zipPath, outDir);

      // Remove the middle receipt from BOTH the index and the directory —
      // exactly what an attacker hiding a decision would do.
      const indexPath = join(outDir, "receipt_index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const removed = index.receipts.splice(1, 1)[0];
      writeFileSync(indexPath, JSON.stringify(index, null, 2));
      rmSync(join(outDir, removed.file));

      const verify = spawnSync("node", ["verify.mjs"], { cwd: outDir, encoding: "utf-8" });
      expect(verify.status).toBe(1);
      expect(verify.stderr).toMatch(/chain link broken|seq gap/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CLI: agentmint export --from receipts/ --out evidence.zip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmint-cli-export-"));
    try {
      // Produce a persistent notary state + sink dir, as a real user would.
      const stateDir = join(dir, "state");
      const sinkDir = join(dir, "receipts");
      const { FileReceiptSink } = await import("./notary.js");
      const notary = new Notary({ stateDir, sink: new FileReceiptSink(sinkDir) });
      const plan = notary.createPlan(planInit);
      notary.notarise({ action: "submit:claim:9", agent: "worker", plan, evidence: { n: 9 } });
      notary.notarise({ action: "read:report", agent: "worker", plan, evidence: { n: 10 } });
      writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));

      const out = join(dir, "evidence.zip");
      const r = spawnSync(
        "npx",
        [
          "tsx", "src/cli/entry.ts", "export",
          "--from", sinkDir,
          "--out", out,
          "--plan", join(dir, "plan.json"),
          "--key", join(stateDir, "notary_key.pem"),
        ],
        { encoding: "utf-8", cwd: process.cwd() },
      );
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(existsSync(out)).toBe(true);

      const outDir = join(dir, "unpacked");
      extract(out, outDir);
      const verify = spawnSync("node", ["verify.mjs"], { cwd: outDir, encoding: "utf-8" });
      expect(verify.status, verify.stdout + verify.stderr).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("packages without a plan still export and verify", () => {
    const notary = new Notary();
    const plan = notary.createPlan(planInit);
    notary.notarise({ action: "submit:claim:1", agent: "worker", plan, evidence: {} });
    const pkg = new EvidencePackage({ publicKeyPem: notary.publicKeyPem });
    for (const r of notary.receipts(plan.id)) pkg.add(r);
    const entries = pkg.buildEntries();
    expect(entries.some((e) => e.name === "plan.json")).toBe(false);
    expect(entries.some((e) => e.name === "receipt_index.json")).toBe(true);
    expect(entries.some((e) => e.name === "verify.mjs")).toBe(true);
  });
});
