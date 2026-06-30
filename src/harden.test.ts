import { describe, expect, it } from "vitest";
import { harden } from "./harden.js";
import { MerkleTree } from "./merkle.js";

describe("harden", () => {
  it("wraps_record", async () => {
    const tools = harden({ foo: async () => 42 });
    expect(await (tools as any).foo()).toBe(42);
  });

  it("enforcement_applied", async () => {
    const tools = harden({ foo: async () => 1 }, { deny: ["foo"] });
    const result = await (tools as any).foo();
    expect(result).toHaveProperty("error", true);
  });

  it("state_accessible", () => {
    const tools = harden({ foo: async () => 1 });
    expect((tools as any).__state().runId).toMatch(/^amr_[a-z0-9]{8}$/);
  });

  it("receipt_is_string", () => {
    const tools = harden({ foo: async () => 1 });
    const receipt = (tools as any).__receipt();
    expect(typeof receipt).toBe("string");
    expect(receipt).toContain("AgentMint");
  });

  it("log_is_array", async () => {
    const tools = harden({ foo: async () => 1 });
    await (tools as any).foo();
    const log = (tools as any).__log();
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("accessors_non_enumerable", () => {
    const tools = harden({ foo: async () => 1 });
    const keys = Object.keys(tools);
    expect(keys).not.toContain("__state");
    expect(keys).not.toContain("__receipt");
    expect(keys).not.toContain("__log");
  });

  it("zero_config", async () => {
    const tools = harden({ foo: async () => 1 });
    await (tools as any).foo();
    const log = (tools as any).__log();
    expect(log).toHaveLength(1);
    expect(log[0].result).toBe("allowed");
  });

  it("bind_enforcement", async () => {
    const tools = harden({ foo: async (p: any) => p }, { bind: { id: "A" } });
    const result = await (tools as any).foo({ id: "B" });
    expect(result).toHaveProperty("error", true);
  });

  it("receipt_sets_completed", () => {
    const tools = harden({ foo: async () => 1 });
    (tools as any).__receipt();
    expect((tools as any).__state().status).toBe("completed");
  });

  it("evidence_chain_disabled_by_default", async () => {
    const tools = harden({ foo: async () => 1 });
    await (tools as any).foo();
    expect((tools as any).__evidence()).toBeNull();
  });

  it("evidence_chain_builds_verifiable_proofs", async () => {
    const tools = harden({ foo: async () => 1, bar: async () => 2 }, { evidenceChain: true });
    await (tools as any).foo();
    await (tools as any).bar();

    const evidence = (tools as any).__evidence();
    expect(evidence).not.toBeNull();
    expect(evidence.leafCount).toBe((tools as any).__log().length);
    expect(evidence.root).toMatch(/^[0-9a-f]{64}$/);

    for (let i = 0; i < evidence.leafCount; i++) {
      const proof = evidence.getProof(i);
      expect(MerkleTree.verify(proof)).toBe(true);
      expect(proof.root).toBe(evidence.root);
    }
  });

  it("evidence_chain_detects_tampering", async () => {
    const tools = harden({ foo: async () => 1 }, { evidenceChain: true });
    await (tools as any).foo();
    const proof = (tools as any).__evidence().getProof(0);
    expect(MerkleTree.verify({ ...proof, leaf: "deadbeef" })).toBe(false);
  });

  it("evidence_root_appears_in_receipt", async () => {
    const tools = harden({ foo: async () => 1 }, { evidenceChain: true });
    await (tools as any).foo();
    expect((tools as any).__receipt()).toContain("Evidence:");
  });
});
