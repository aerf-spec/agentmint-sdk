// Signed plans: sign/verify, expiry, policy evaluation, scope intersection,
// and policy hash.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  signPlan,
  verifyPlan,
  isPlanExpired,
  evaluatePolicy,
  computePolicyHash,
  intersectScopes,
  delegatePlan,
  matchesPattern,
  type PlanReceipt,
} from "./plan.js";
import {
  generateKeyPair,
  publicKeyToPem,
  privateKeyToPem,
} from "./kernel/sign.js";

function newKeys() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKeyPem: publicKeyToPem(publicKey), privateKeyPem: privateKeyToPem(privateKey) };
}

const planInit = {
  user: "admin@example.com",
  action: "handle-claims",
  scope: ["submit:claim:*", "read:reports"],
  checkpoints: ["submit:claim:high-value:*"],
  delegatesTo: ["claims-agent"],
};

describe("matchesPattern", () => {
  it("implements the colon-scope semantics of patterns.py", () => {
    expect(matchesPattern("anything", "*")).toBe(true);
    expect(matchesPattern("read:reports", "read:reports:*")).toBe(true);
    expect(matchesPattern("read:reports:q3", "read:reports:*")).toBe(true);
    expect(matchesPattern("read:reportsx", "read:reports:*")).toBe(false);
    expect(matchesPattern("read:reports", "read:reports")).toBe(true);
    expect(matchesPattern("tts:standardx", "tts:standard*")).toBe(false);
  });
});

describe("signPlan / verifyPlan", () => {
  it("produces a signed plan that verifies and rejects tampering", () => {
    const keys = newKeys();
    const plan = signPlan(planInit, keys.privateKeyPem);
    expect(plan.type).toBe("plan");
    expect(verifyPlan(plan, keys.publicKeyPem)).toBe(true);
    expect(verifyPlan({ ...plan, scope: ["*"] }, keys.publicKeyPem)).toBe(false);
    expect(verifyPlan(plan, newKeys().publicKeyPem)).toBe(false);
  });

  it("clamps TTL to [1, 3600] and supports never-expires", () => {
    const keys = newKeys();
    const issuedAt = "2026-01-01T00:00:00.000000+00:00";
    const capped = signPlan({ ...planInit, ttlSeconds: 999999, issuedAt }, keys.privateKeyPem);
    expect(new Date(capped.expires_at).getTime()).toBe(
      new Date(issuedAt).getTime() + 3600 * 1000,
    );
    const forever = signPlan({ ...planInit, ttlSeconds: null }, keys.privateKeyPem);
    expect(forever.expires_at.startsWith("9999-12-31")).toBe(true);
    expect(isPlanExpired(forever)).toBe(false);
  });

  it("isPlanExpired matches Python's >= comparison", () => {
    const expires = "2026-01-01T00:00:00.000000+00:00";
    const plan = { expires_at: expires };
    expect(isPlanExpired(plan, new Date("2025-12-31T23:59:59Z"))).toBe(false);
    expect(isPlanExpired(plan, new Date("2026-01-01T00:00:00Z"))).toBe(true);
    expect(isPlanExpired(plan, new Date("2026-01-01T00:00:01Z"))).toBe(true);
  });
});

describe("evaluatePolicy", () => {
  const keys = newKeys();
  const plan = signPlan(planInit, keys.privateKeyPem);

  it("blocks on expiry before anything else", () => {
    const expired = { ...plan, expires_at: "2020-01-01T00:00:00+00:00" };
    expect(evaluatePolicy("submit:claim:CLM-1", "claims-agent", expired)).toEqual({
      inPolicy: false,
      reason: "plan expired",
    });
  });

  it("restricts by delegates_to", () => {
    const res = evaluatePolicy("submit:claim:CLM-1", "rogue-agent", plan);
    expect(res.inPolicy).toBe(false);
    expect(res.reason).toContain("not in delegates_to");
  });

  it("checkpoints block before scope allows", () => {
    const res = evaluatePolicy("submit:claim:high-value:CLM-9", "claims-agent", plan);
    expect(res.inPolicy).toBe(false);
    expect(res.reason).toBe("matched checkpoint submit:claim:high-value:*");
  });

  it("scope allows, default denies", () => {
    expect(evaluatePolicy("submit:claim:CLM-1", "claims-agent", plan)).toEqual({
      inPolicy: true,
      reason: "matched scope submit:claim:*",
    });
    expect(evaluatePolicy("delete:database", "claims-agent", plan)).toEqual({
      inPolicy: false,
      reason: "no scope pattern matched",
    });
  });
});

describe("intersectScopes / delegatePlan", () => {
  it("keeps the more specific pattern in either direction", () => {
    expect(intersectScopes(["read:*"], ["read:reports"])).toEqual(["read:reports"]);
    expect(intersectScopes(["read:reports"], ["read:*"])).toEqual(["read:reports"]);
    expect(intersectScopes(["read:a", "read:b"], ["read:a", "read:c"])).toEqual(["read:a"]);
    expect(intersectScopes(["write:*"], ["read:*"])).toEqual([]);
  });

  it("delegatePlan narrows scope and pins the child agent", () => {
    const keys = newKeys();
    const parent = signPlan(planInit, keys.privateKeyPem);
    const child = delegatePlan(
      parent,
      { childAgent: "sub-agent", requestedScope: ["submit:claim:small:*"] },
      keys.privateKeyPem,
    );
    expect(child.scope).toEqual(["submit:claim:small:*"]);
    expect(child.delegates_to).toEqual(["sub-agent"]);
    expect(verifyPlan(child, keys.publicKeyPem)).toBe(true);
    expect(() =>
      delegatePlan(parent, { childAgent: "x", requestedScope: ["delete:*"] }, keys.privateKeyPem),
    ).toThrow(/intersection is empty/);
  });
});

describe("computePolicyHash", () => {
  it("hashes canonical {scope, checkpoints, delegates_to}", () => {
    const keys = newKeys();
    const plan = signPlan(planInit, keys.privateKeyPem);
    const again = signPlan(planInit, newKeys().privateKeyPem);
    // Independent of key/id/timestamps — pure policy identity.
    expect(computePolicyHash(plan)).toBe(computePolicyHash(again));
    expect(computePolicyHash({ ...plan, scope: ["*"] })).not.toBe(computePolicyHash(plan));
  });

  const pythonAvailable =
    existsSync(".vendor/agentmint-python") &&
    spawnSync("python3", ["-c", "import nacl"], { encoding: "utf-8" }).status === 0;

  it.skipIf(!pythonAvailable)("matches the Python producer's _compute_policy_hash", () => {
    const keys = newKeys();
    const plan = signPlan(planInit, keys.privateKeyPem);
    const r = spawnSync(
      "python3",
      [
        "-c",
        `
import sys, json
sys.path.insert(0, ".vendor/agentmint-python")
from agentmint.notary import PlanReceipt, _compute_policy_hash
p = json.load(sys.stdin)
plan = PlanReceipt(id=p["id"], user=p["user"], action=p["action"],
    scope=tuple(p["scope"]), checkpoints=tuple(p["checkpoints"]),
    delegates_to=tuple(p["delegates_to"]), issued_at=p["issued_at"],
    expires_at=p["expires_at"], signature=p["signature"], key_id=p["key_id"])
print(_compute_policy_hash(plan), end="")
`,
      ],
      { input: JSON.stringify(plan), encoding: "utf-8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(computePolicyHash(plan)).toBe(r.stdout);
  });
});
