// Incremental RFC 6962 Merkle log over precomputed leaf hashes.
//
// Hashes of complete, aligned power-of-two subtrees are cached as they form,
// so append is amortized O(1) and roots, inclusion proofs and consistency
// proofs need O(log n) cached lookups. Ranges on the ragged right edge (not
// power-of-two) are memoized per (start, size), which keeps a whole batch of
// proofs against one tree size at O(log n) each.
import { hashInternal } from "../src/merkle.js";
import { sha256Hex } from "../src/kernel/canonical.js";

const EMPTY_ROOT = sha256Hex(Buffer.alloc(0));
const HEX64 = /^[0-9a-f]{64}$/;

function largestPow2Below(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export class IncrementalLog {
  /** levels[k][i] = hash of the complete subtree of 2^k leaves starting at i * 2^k. */
  private readonly levels: string[][] = [[]];
  private memo = new Map<string, string>();

  get size(): number {
    return this.levels[0]!.length;
  }

  append(leafHash: string): number {
    if (!HEX64.test(leafHash)) throw new TypeError("leaf hash must be 64 lowercase hex characters");
    const leaves = this.levels[0]!;
    const index = leaves.push(leafHash) - 1;
    let k = 0;
    let i = index;
    while (i % 2 === 1) {
      const level = this.levels[k]!;
      const parent = hashInternal(level[i - 1]!, level[i]!);
      k += 1;
      (this.levels[k] ??= []).push(parent);
      i = (i - 1) / 2;
    }
    return index;
  }

  /** MTH(D[start : start + n]). */
  private mth(start: number, n: number): string {
    if (n === 0) return EMPTY_ROOT;
    if ((n & (n - 1)) === 0 && start % n === 0) {
      return this.levels[Math.log2(n)]![start / n]!;
    }
    const key = `${start}:${n}`;
    const hit = this.memo.get(key);
    if (hit) return hit;
    const k = largestPow2Below(n);
    const h = hashInternal(this.mth(start, k), this.mth(start + k, n - k));
    if (this.memo.size > 4096) this.memo = new Map();
    this.memo.set(key, h);
    return h;
  }

  root(treeSize = this.size): string {
    this.checkSize(treeSize);
    return this.mth(0, treeSize);
  }

  /** RFC 6962 audit path for leaf `index` in the tree of size `treeSize`. */
  inclusionProof(index: number, treeSize = this.size): string[] {
    this.checkSize(treeSize);
    if (index < 0 || index >= treeSize) throw new RangeError(`leaf ${index} not in tree of size ${treeSize}`);
    const out: string[] = [];
    let start = 0;
    let n = treeSize;
    let m = index;
    const right: string[] = [];
    // Walk root→leaf, collecting siblings; the proof is leaf→root.
    while (n > 1) {
      const k = largestPow2Below(n);
      if (m < k) {
        right.push(this.mth(start + k, n - k));
        n = k;
      } else {
        right.push(this.mth(start, k));
        start += k;
        m -= k;
        n -= k;
      }
    }
    for (let i = right.length - 1; i >= 0; i--) out.push(right[i]!);
    return out;
  }

  /** RFC 6962 §2.1.2 consistency proof between tree sizes m <= n. */
  consistencyProof(m: number, n = this.size): string[] {
    this.checkSize(n);
    if (m < 1 || m > n) throw new RangeError(`invalid consistency range ${m}..${n}`);
    const sub = (m: number, start: number, n: number, complete: boolean): string[] => {
      if (m === n) return complete ? [] : [this.mth(start, m)];
      const k = largestPow2Below(n);
      if (m <= k) return [...sub(m, start, k, complete), this.mth(start + k, n - k)];
      return [...sub(m - k, start + k, n - k, false), this.mth(start, k)];
    };
    return sub(m, 0, n, true);
  }

  private checkSize(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.size) throw new RangeError(`tree size ${n} out of range`);
  }
}

/** RFC 9162 §2.1.4.2 consistency verification. */
export function verifyConsistency(
  m: number,
  n: number,
  oldRoot: string,
  newRoot: string,
  proof: readonly string[],
): boolean {
  if (m < 1 || m > n) return false;
  if (m === n) return proof.length === 0 && oldRoot === newRoot;
  const path = (m & (m - 1)) === 0 ? [oldRoot, ...proof] : [...proof];
  if (path.length === 0) return false;
  let fn = m - 1;
  let sn = n - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = hashInternal(c, fr);
      sr = hashInternal(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      sr = hashInternal(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && fr === oldRoot && sr === newRoot;
}

/** Which side each audit-path sibling sits on, leaf→root (mirrors walkAuditPath). */
export function auditPathSides(
  leafIndex: number,
  treeSize: number,
  path: readonly string[],
): Array<{ hash: string; side: "left" | "right" }> {
  let fn = leafIndex;
  let sn = treeSize - 1;
  return path.map((hash) => {
    let side: "left" | "right";
    if (fn % 2 === 1 || fn === sn) {
      side = "left";
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      side = "right";
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
    return { hash, side };
  });
}
