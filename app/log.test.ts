import { describe, expect, it } from "vitest";
import { IncrementalLog, auditPathSides, verifyConsistency } from "./log.js";
import { MerkleTree, logLeafHash, walkAuditPath } from "../src/merkle.js";

const leaf = (i: number) => logLeafHash(`leaf-${i}`);

describe("IncrementalLog", () => {
  it("root and every inclusion proof equal MerkleTree's for sizes 1..33", () => {
    const log = new IncrementalLog();
    const tree = new MerkleTree();
    for (let n = 1; n <= 33; n++) {
      log.append(leaf(n - 1));
      tree.addLeafHash(leaf(n - 1));
      expect(log.root(), `root n=${n}`).toBe(tree.build());
      for (let i = 0; i < n; i++) {
        const path = log.inclusionProof(i);
        expect(path, `path n=${n} i=${i}`).toEqual(tree.auditPath(i));
        expect(walkAuditPath(leaf(i), path, i, n)).toBe(tree.build());
      }
    }
  });

  it("serves proofs and roots for older tree sizes", () => {
    const log = new IncrementalLog();
    for (let i = 0; i < 20; i++) log.append(leaf(i));
    const t7 = new MerkleTree();
    for (let i = 0; i < 7; i++) t7.addLeafHash(leaf(i));
    expect(log.root(7)).toBe(t7.build());
    expect(log.inclusionProof(3, 7)).toEqual(t7.auditPath(3));
  });

  it("consistency proofs verify for every 1 <= m <= n <= 33, and fail when tampered", () => {
    const log = new IncrementalLog();
    for (let i = 0; i < 33; i++) log.append(leaf(i));
    for (let n = 1; n <= 33; n++) {
      for (let m = 1; m <= n; m++) {
        const proof = log.consistencyProof(m, n);
        expect(verifyConsistency(m, n, log.root(m), log.root(n), proof), `m=${m} n=${n}`).toBe(true);
        if (m < n) {
          expect(verifyConsistency(m, n, log.root(m), leaf(99), proof)).toBe(false);
          if (proof.length > 0) {
            const bad = [...proof];
            bad[0] = leaf(98);
            expect(verifyConsistency(m, n, log.root(m), log.root(n), bad)).toBe(false);
          }
        }
      }
    }
  });

  it("rejects malformed leaves and out-of-range sizes", () => {
    const log = new IncrementalLog();
    expect(() => log.append("XYZ")).toThrow(TypeError);
    log.append(leaf(0));
    expect(() => log.inclusionProof(1)).toThrow(RangeError);
    expect(() => log.consistencyProof(2, 1)).toThrow(RangeError);
    expect(() => log.root(5)).toThrow(RangeError);
  });

  it("auditPathSides labels siblings so a left/right fold reproduces the root", () => {
    const log = new IncrementalLog();
    for (let i = 0; i < 11; i++) log.append(leaf(i));
    for (let i = 0; i < 11; i++) {
      const sides = auditPathSides(i, 11, log.inclusionProof(i));
      const tree = new MerkleTree();
      for (let j = 0; j < 11; j++) tree.addLeafHash(leaf(j));
      expect(sides.map((s) => s.side)).toEqual(tree.getProof(i).siblings.map((s) => s.position));
    }
  });
});
