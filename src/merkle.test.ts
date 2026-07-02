import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  canonicalize,
  MerkleTree,
  logLeafHash,
  hashInternal,
  walkAuditPath,
} from "./merkle.js";

describe("canonicalize", () => {
  it("produces deterministic output regardless of key order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("sorts nested objects recursively", () => {
    const result = canonicalize({ z: { b: 1, a: 2 }, a: 3 });

    expect(result).toBe('{"a":3,"z":{"a":2,"b":1}}');
  });

  it("throws on undefined", () => {
    expect(() => canonicalize({ x: undefined })).toThrow("Unsupported value");
  });
});

describe("MerkleTree", () => {
  it("single leaf verifies", () => {
    const tree = new MerkleTree();

    tree.addLeaf("event-0");
    tree.build();

    expect(MerkleTree.verify(tree.getProof(0))).toBe(true);
  });

  it("eight leaves each verify independently", () => {
    const tree = new MerkleTree();

    for (let i = 0; i < 8; i += 1) {
      tree.addLeaf(`event-${i}`);
    }

    tree.build();

    for (let i = 0; i < 8; i += 1) {
      expect(MerkleTree.verify(tree.getProof(i))).toBe(true);
    }
  });

  it("detects tampering", () => {
    const tree = new MerkleTree();

    tree.addLeaf("event-0");
    tree.build();

    const proof = tree.getProof(0);
    const tampered = { ...proof, leaf: "deadbeef" };

    expect(MerkleTree.verify(tampered)).toBe(false);
  });

  it("selective disclosure proves subset without revealing others", () => {
    const tree = new MerkleTree();

    for (let i = 0; i < 8; i += 1) {
      tree.addLeaf(`event-${i}`);
    }

    tree.build();

    const proof2 = tree.getProof(2);
    const proof5 = tree.getProof(5);

    expect(MerkleTree.verify(proof2)).toBe(true);
    expect(MerkleTree.verify(proof5)).toBe(true);
    expect(proof2.root).toBe(proof5.root);

    const allHashes2 = proof2.siblings.map((sibling) => sibling.hash);
    const allHashes5 = proof5.siblings.map((sibling) => sibling.hash);

    expect(allHashes2).not.toContain(proof5.leaf);
    expect(allHashes5).not.toContain(proof2.leaf);
  });

  it("same data produces same root", () => {
    const t1 = new MerkleTree();
    const t2 = new MerkleTree();

    for (let i = 0; i < 4; i += 1) {
      t1.addLeaf(`event-${i}`);
      t2.addLeaf(`event-${i}`);
    }

    expect(t1.build()).toBe(t2.build());
  });

  it("every proof verifies for every non-power-of-two size (1..17), including right edges", () => {
    for (let n = 1; n <= 17; n++) {
      const tree = new MerkleTree();
      for (let i = 0; i < n; i++) tree.addLeaf(`leaf-${i}`);
      const root = tree.build();
      for (let i = 0; i < n; i++) {
        const proof = tree.getProof(i);
        expect(MerkleTree.verify(proof), `n=${n} i=${i}`).toBe(true);
        // The bare audit path verifies through the RFC 9162 walk too.
        expect(walkAuditPath(logLeafHash(`leaf-${i}`), tree.auditPath(i), i, n)).toBe(root);
      }
    }
  });

  it("uses RFC 6962 domain separation: leaf and interior prefixes differ", () => {
    const data = "payload";
    expect(logLeafHash(data)).toBe(
      createHash("sha256").update(Buffer.from([0x00])).update(data).digest("hex"),
    );
    expect(hashInternal("aa".repeat(32), "bb".repeat(32))).toBe(
      createHash("sha256")
        .update(Buffer.concat([Buffer.from([0x01]), Buffer.from("aa".repeat(32), "hex"), Buffer.from("bb".repeat(32), "hex")]))
        .digest("hex"),
    );
  });

  it("second preimage: an interior node cannot be presented as a leaf", () => {
    // Build a 4-leaf tree, then try to forge a 2-leaf tree whose leaves are
    // the interior nodes' byte concatenations. With domain separation the
    // forged root differs, so the splice is detectable.
    const tree = new MerkleTree();
    const data = ["a", "b", "c", "d"];
    for (const d of data) tree.addLeaf(d);
    const root = tree.build();

    const l = data.map((d) => logLeafHash(d));
    const inner01 = Buffer.concat([Buffer.from(l[0]!, "hex"), Buffer.from(l[1]!, "hex")]);
    const inner23 = Buffer.concat([Buffer.from(l[2]!, "hex"), Buffer.from(l[3]!, "hex")]);

    const forged = new MerkleTree();
    forged.addLeaf(inner01);
    forged.addLeaf(inner23);
    expect(forged.build()).not.toBe(root);
  });

  it("walkAuditPath rejects structurally invalid proofs", () => {
    const tree = new MerkleTree();
    for (let i = 0; i < 5; i++) tree.addLeaf(`leaf-${i}`);
    const root = tree.build();
    const leaf = logLeafHash("leaf-2");
    const path = tree.auditPath(2);
    expect(walkAuditPath(leaf, path, 2, 5)).toBe(root);
    // Truncated path, extended path, wrong index, index out of range:
    expect(walkAuditPath(leaf, path.slice(0, -1), 2, 5)).not.toBe(root);
    expect(walkAuditPath(leaf, [...path, "00".repeat(32)], 2, 5)).not.toBe(root);
    expect(walkAuditPath(leaf, path, 1, 5)).not.toBe(root);
    expect(walkAuditPath(leaf, path, 7, 5)).toBe("");
  });
});

describe("cross-check against the AERF reference primitives", () => {
  const vendorAvailable =
    existsSync(".vendor/aerf/tools/aerf_primitives.py") &&
    spawnSync("python3", ["-c", "import cryptography"], { encoding: "utf-8" }).status === 0;

  it.skipIf(!vendorAvailable)(
    "root and audit path match tools/aerf_primitives.py for sizes 1..9",
    () => {
      const script = `
import sys, json
sys.path.insert(0, ".vendor/aerf/tools")
from aerf_primitives import leaf_hash, merkle_root, audit_path
spec = json.load(sys.stdin)
out = []
for n in spec["sizes"]:
    data = [f"leaf-{i}".encode() for i in range(n)]
    leaves = [leaf_hash(d) for d in data]
    entry = {"n": n, "root": merkle_root(leaves).hex(), "paths": []}
    for i in range(n):
        entry["paths"].append([h.hex() for h in audit_path(leaves, i)])
    out.append(entry)
print(json.dumps(out))
`;
      const r = spawnSync("python3", ["-c", script], {
        input: JSON.stringify({ sizes: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
        encoding: "utf-8",
      });
      expect(r.status, r.stderr).toBe(0);
      const reference = JSON.parse(r.stdout) as Array<{ n: number; root: string; paths: string[][] }>;
      for (const { n, root, paths } of reference) {
        const tree = new MerkleTree();
        for (let i = 0; i < n; i++) tree.addLeaf(`leaf-${i}`);
        expect(tree.build(), `root n=${n}`).toBe(root);
        for (let i = 0; i < n; i++) {
          expect(tree.auditPath(i), `path n=${n} i=${i}`).toEqual(paths[i]);
        }
      }
    },
  );
});
