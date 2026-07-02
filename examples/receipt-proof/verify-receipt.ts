// verify-receipt.ts — shared, model-free receipt/evidence verification.
//
// This is the single source of truth for AgentMint's tamper-evidence checks:
// prove.ts calls it as its standalone proof, and the benchmark's post-run
// receipt-verification pass (run-all.ts) calls the same logic over every
// hardened/shaped run — so both prove the property with identical code.
//
// Pure and fast: recompute the Merkle root from a run's event log, validate a
// proof, and show single-field tampering is detected. No model, no network, no
// I/O. Uses only what src/index.ts already exports — MerkleTree, canonicalize.

import {
  MerkleTree,
  canonicalize,
  type Event,
  type MerkleProof,
} from "../../src/index.ts";

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** The built evidence handle a hardened toolset returns from __evidence(). */
export interface EvidenceHandle {
  root: string;
  leafCount: number;
  getProof(index: number): MerkleProof;
}

/** Minimal shape of a hardened toolset needed to verify its evidence chain. */
export interface HardenedHandle {
  __state(): { events: Event[] };
  __evidence(): EvidenceHandle | null;
}

export interface VerifyResult {
  checks: Check[];
  allPass: boolean;
  originalRoot: string;
  tamperedRoot: string;
  tamperedIndex: number;
}

/** Truncate a hex root for compact, still-recognizable display. */
export function short(hash: string): string {
  return hash.length > 16 ? `${hash.slice(0, 16)}…` : hash;
}

/**
 * Run the tamper-evidence checks against a run's ordered event log and its built
 * Merkle evidence. Deterministic, pure, no I/O. Tampers the first blocked event
 * when present (the "hide a block" attack), otherwise the first event.
 */
export function verifyEvidence(
  events: readonly Event[],
  evidence: EvidenceHandle,
): VerifyResult {
  const checks: Check[] = [];

  if (events.length === 0) {
    checks.push({
      name: "Run has at least one event to anchor evidence",
      pass: false,
      detail: "event log is empty; nothing to verify",
    });
    return {
      checks,
      allPass: false,
      originalRoot: evidence.root,
      tamperedRoot: evidence.root,
      tamperedIndex: -1,
    };
  }

  const blockedIndex = events.findIndex((e) => e.result === "blocked");
  const tamperedIndex = blockedIndex >= 0 ? blockedIndex : 0;

  // 1. Independent reconstruction: hashing the event log ourselves with only the
  //    exported MerkleTree + canonicalize reproduces the receipt's root. This is
  //    what an outside auditor does — recompute the root from the evidence.
  const rebuilt = new MerkleTree();
  for (const e of events) rebuilt.addLeaf(canonicalize(e));
  const rebuiltRoot = rebuilt.build();
  checks.push({
    name: "Evidence root is independently reconstructible from the event log",
    pass: rebuiltRoot === evidence.root,
    detail: `rebuilt ${short(rebuiltRoot)} === receipt ${short(evidence.root)}`,
  });

  // 2. A Merkle proof for the chosen event validates against the root.
  const proof = evidence.getProof(tamperedIndex);
  const proofValidates = MerkleTree.verify(proof);
  const proofBindsToRoot = proof.root === evidence.root;
  checks.push({
    name: "Merkle proof validates against the root",
    pass: proofValidates && proofBindsToRoot,
    detail: `MerkleTree.verify(proof)=${proofValidates}, proof.root===evidence.root=${proofBindsToRoot}`,
  });

  // Tamper: mutate ONE field in a COPY of the event log, then recompute.
  const tampered: Event[] = JSON.parse(JSON.stringify(events)) as Event[];
  const target = tampered[tamperedIndex] as { result: string };
  target.result = target.result === "blocked" ? "allowed" : "blocked";
  const tamperedTree = new MerkleTree();
  for (const e of tampered) tamperedTree.addLeaf(canonicalize(e));
  const tamperedRoot = tamperedTree.build();

  // 3. A single-field mutation changes the Merkle root.
  checks.push({
    name: "Mutating one event field changes the Merkle root",
    pass: tamperedRoot !== evidence.root,
    detail: `original ${short(evidence.root)} != tampered ${short(tamperedRoot)}`,
  });

  // 4. The honest root REJECTS a proof built over the tampered event. Same
  //    sibling path (untouched subtrees), tampered leaf, honest root → fails.
  const tamperedLeaf = tamperedTree.getProof(tamperedIndex).leaf;
  const forged: MerkleProof = {
    leaf: tamperedLeaf,
    index: tamperedIndex,
    siblings: proof.siblings,
    root: evidence.root,
  };
  const forgedRejected = MerkleTree.verify(forged) === false;
  checks.push({
    name: "Honest root rejects a proof over the tampered event",
    pass: forgedRejected,
    detail: `MerkleTree.verify(tamperedLeaf @ honestRoot)=${MerkleTree.verify(forged)}`,
  });

  return {
    checks,
    allPass: checks.every((c) => c.pass),
    originalRoot: evidence.root,
    tamperedRoot,
    tamperedIndex,
  };
}

/**
 * Convenience wrapper: verify a live hardened toolset. `evidenceChain` must be
 * enabled in its harden() config, or __evidence() returns null and this throws.
 */
export function verifyHardenedRun(tools: HardenedHandle): VerifyResult {
  const evidence = tools.__evidence();
  if (!evidence) {
    throw new Error("evidenceChain is not enabled — __evidence() returned null");
  }
  return verifyEvidence(tools.__state().events, evidence);
}
