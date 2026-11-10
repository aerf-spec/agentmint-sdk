// RFC 6962 / RFC 9162 Merkle log algorithms over a store of cached
// complete-subtree hashes.
//
// Node (level, idx) is the hash of the complete, aligned subtree covering
// leaves [idx * 2^level, (idx + 1) * 2^level). Level 0 holds the leaf hashes
// (already SHA-256(0x00 || data) — the authority only ever receives hashes).
// Every node is written exactly once, when its subtree becomes complete, so
// the store is append-only like the log itself.
//
// Any MTH(D[start : start+size]) reached from the RFC 6962 split of D[0:n]
// decomposes into O(log n) cached nodes (the binary digits of `size`), which
// makes root, inclusion and consistency O(log n) node reads.

import { emptyRoot, hashInternal, toHex } from "./crypto";

export interface NodeReader {
  /** Hash of complete node (level, idx); throws if absent. */
  get(level: number, idx: number): Uint8Array;
}

/** Largest power of two strictly less than n (n >= 2). */
export function largestPow2Below(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function log2(n: number): number {
  return 31 - Math.clz32(n);
}

/**
 * MTH over [start, start+size) with a per-request memo (proofs for leaves in
 * the same batch share most right-edge subtrees).
 */
export class TreeView {
  private memo = new Map<string, Uint8Array>();
  constructor(private readonly nodes: NodeReader) {}

  async subtree(start: number, size: number): Promise<Uint8Array> {
    if (size === 0) return emptyRoot();
    if (isPow2(size) && start % size === 0) return this.nodes.get(log2(size), start / size);
    const key = `${start}:${size}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const k = largestPow2Below(size);
    const h = await hashInternal(await this.subtree(start, k), await this.subtree(start + k, size - k));
    this.memo.set(key, h);
    return h;
  }

  root(treeSize: number): Promise<Uint8Array> {
    return this.subtree(0, treeSize);
  }

  /** RFC 6962 §2.1.1 PATH(m, D[n]), leaf → root order (matches SDK MerkleTree.auditPath). */
  async inclusion(m: number, treeSize: number): Promise<string[]> {
    if (m < 0 || m >= treeSize) throw new RangeError("leaf index out of range");
    const out: Uint8Array[] = [];
    const walk = async (m: number, start: number, size: number): Promise<void> => {
      if (size <= 1) return;
      const k = largestPow2Below(size);
      if (m < k) {
        await walk(m, start, k);
        out.push(await this.subtree(start + k, size - k));
      } else {
        await walk(m - k, start + k, size - k);
        out.push(await this.subtree(start, k));
      }
    };
    await walk(m, 0, treeSize);
    return out.map(toHex);
  }

  /** RFC 6962 §2.1.2 PROOF(m, D[n]) = SUBPROOF(m, D[n], true). */
  async consistency(m: number, n: number): Promise<string[]> {
    if (m < 1 || m > n) throw new RangeError("need 1 <= from <= to");
    const out: Uint8Array[] = [];
    const sub = async (m: number, start: number, size: number, b: boolean): Promise<void> => {
      if (m === size) {
        if (!b) out.push(await this.subtree(start, size));
        return;
      }
      const k = largestPow2Below(size);
      if (m <= k) {
        await sub(m, start, k, b);
        out.push(await this.subtree(start + k, size - k));
      } else {
        await sub(m - k, start + k, size - k, false);
        out.push(await this.subtree(start, k));
      }
    };
    await sub(m, 0, n, true);
    return out.map(toHex);
  }
}

/**
 * Append leaves at positions [size, size + leaves.length), computing every
 * node that becomes complete. Returns the new nodes; nothing is written.
 */
export async function appendLeaves(
  nodes: NodeReader,
  size: number,
  leaves: Uint8Array[],
): Promise<{ pending: Map<string, { level: number; idx: number; hash: Uint8Array }>; reader: NodeReader }> {
  const pending = new Map<string, { level: number; idx: number; hash: Uint8Array }>();
  const reader: NodeReader = {
    get(level, idx) {
      const p = pending.get(`${level}:${idx}`);
      return p ? p.hash : nodes.get(level, idx);
    },
  };
  const put = (level: number, idx: number, hash: Uint8Array) => pending.set(`${level}:${idx}`, { level, idx, hash });
  for (let i = 0; i < leaves.length; i++) {
    const pos = size + i;
    put(0, pos, leaves[i]!);
    // Leaf `pos` completes the level-L node ending at it whenever 2^L divides pos+1.
    let idx = pos;
    let level = 0;
    while (idx % 2 === 1) {
      const h = await hashInternal(reader.get(level, idx - 1), reader.get(level, idx));
      level += 1;
      idx = (idx - 1) / 2;
      put(level, idx, h);
    }
  }
  return { pending, reader };
}
