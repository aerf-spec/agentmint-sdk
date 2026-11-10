// The signer process: key isolation, WAL crash recovery, idempotent re-send,
// authority outage, load with zero loss, and (opt-in) the production authority.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { runLoad, startHarness, type Harness } from "./bench.js";
import { SignerClient, type BatchEvent } from "./signer.js";
import { verifyAerfChain } from "../src/chain.js";
import { verifyAerfReceipt } from "../src/receipt-aerf.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const sign = (planId: string, n: number) =>
  h.signer.sign({ plan_id: planId, action: "decide:x", agent: "a", evidence: { n } });

function waitFor<T>(signer: SignerClient, ev: string, pred: (x: T) => boolean, ms = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    const on = (x: T) => {
      if (!pred(x)) return;
      clearTimeout(t);
      signer.off(ev, on);
      resolve(x);
    };
    signer.on(ev, on);
  });
}

describe("signer process", () => {
  it("holds the issuer key: the agent side only ever sees the public key", () => {
    expect(h.signer.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    const fields = Object.values(h.signer).filter((v) => typeof v === "string") as string[];
    expect(fields.some((v) => v.includes("PRIVATE KEY"))).toBe(false);
    expect(process.env.ISSUER_PRIVATE_KEY_PEM).toBeUndefined();
    expect(h.signer.pid).not.toBe(process.pid);
  });

  it("idempotent: re-sending the same request returns the same receipt", async () => {
    const plan = await h.signer.openPlan({ user: "u", action: "a", scope: ["decide:*"] });
    const input = { plan_id: plan.id, action: "decide:x", agent: "a", evidence: { n: 1 } };
    const a = await h.signer.sign(input, "same-key");
    const b = await h.signer.sign(input, "same-key");
    expect(b.receipt.id).toBe(a.receipt.id);
    expect(b.replay).toBe(true);
    expect((await sign(plan.id, 2)).receipt.seq).toBe(2);
  });

  it("crash with a request in flight: restarts from the WAL, no gap, no fork", async () => {
    const plan = await h.signer.openPlan({ user: "u", action: "a", scope: ["decide:*"] });
    const before = [await sign(plan.id, 1), await sign(plan.id, 2), await sign(plan.id, 3)];
    const pid = h.signer.pid;
    const up = waitFor<{ downtime_ms: number }>(h.signer, "up", () => true);
    const inflight = sign(plan.id, 4); // sent, then the process is killed
    h.signer.crash();
    const after = [await inflight, await sign(plan.id, 5)];
    await up;
    expect(h.signer.pid).not.toBe(pid);
    const chain = [...before, ...after].map((r) => r.receipt);
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    const v = verifyAerfChain(chain, { issuerPublicKey: h.signer.publicKeyPem });
    expect(v.valid, v.reason).toBe(true);
  });

  it("authority outage: anchoring backs off, then anchors everything late with delayed=true", async () => {
    const plan = await h.signer.openPlan({ user: "u", action: "a", scope: ["decide:*"] });
    const failures: unknown[] = [];
    const onFail = (f: { plans: string[] }) => f.plans.includes(plan.id) && failures.push(f);
    h.signer.on("anchor_failure", onFail);
    await h.signer.failAuthority(700);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) ids.add((await sign(plan.id, i)).receipt.id as string);
    const anchored = new Map<string, boolean>();
    await new Promise<void>((resolve) => {
      const on = (b: BatchEvent) => {
        for (const it of b.items) if (ids.has(it.receipt_id)) anchored.set(it.receipt_id, b.delayed);
        if (anchored.size === ids.size) {
          h.signer.off("batch", on);
          resolve();
        }
      };
      h.signer.on("batch", on);
    });
    h.signer.off("anchor_failure", onFail);
    expect(failures.length).toBeGreaterThan(0);
    expect([...anchored.values()].every(Boolean)).toBe(true);
  });

  it("load: burst of 1,000 and 300 at 50/s, zero loss, every receipt anchored and verified", async () => {
    await runLoad(h, { count: 100, rate: 0, label: "warmup" });
    const burst = await runLoad(h, { count: 1000, rate: 0 });
    const paced = await runLoad(h, { count: 300, rate: 50 });
    console.log("[load] burst", JSON.stringify(burst));
    console.log("[load] 50/s ", JSON.stringify(paced));
    for (const r of [burst, paced]) {
      expect(r.lost).toBe(0);
      expect(r.anchored).toBe(r.count);
      expect(r.chain_valid).toBe(true);
    }
    // Hot path (agent → signed receipt, including IPC) stays in the low
    // milliseconds even on a noisy CI box; the README reports measured numbers.
    expect(paced.hot_path_us.p50).toBeLessThan(2000);
    expect(paced.sign_us.p99).toBeLessThan(2000);
  });
});

describe.skipIf(!process.env.AUTHORITY_URL)("production authority (AUTHORITY_URL)", () => {
  it("registers, anchors a batch, and the SDK verifier accepts the proofs", async () => {
    const url = process.env.AUTHORITY_URL!.replace(/\/+$/, "").replace(/\/authority$/, "");
    const key = (await (await fetch(`${url}/authority/v1/key`)).json()) as { public_key_pem: string };
    const signer = await SignerClient.start({ authorityUrl: url, stateDir: mkdtempSync(join(tmpdir(), "filet-remote-")) });
    try {
      const plan = await signer.openPlan({ user: "ci", action: "ci", scope: ["decide:*"] });
      const signed: Awaited<ReturnType<SignerClient["sign"]>>[] = [];
      for (let i = 0; i < 2; i++) signed.push(await signer.sign({ plan_id: plan.id, action: "decide:ci", agent: "ci", evidence: { i } }));
      const ids = new Set(signed.map((s) => s.receipt.id as string));
      const got = new Map<string, Record<string, unknown>>();
      await new Promise<void>((resolve) => {
        signer.on("batch", (b: BatchEvent) => {
          for (const it of b.items) {
            if (!ids.has(it.receipt_id)) continue;
            const r = signed.find((s) => s.receipt.id === it.receipt_id)!.receipt;
            got.set(it.receipt_id, { ...r, log_inclusion_proof: it.proof });
          }
          if (got.size === ids.size) resolve();
        });
      });
      for (const r of got.values()) {
        const v = verifyAerfReceipt(r, { issuerPublicKey: createPublicKey(signer.publicKeyPem), logPublicKey: key.public_key_pem, requireLog: true });
        expect(v.ok, v.failReason).toBe(true);
      }
    } finally {
      signer.stop();
    }
  });
});
