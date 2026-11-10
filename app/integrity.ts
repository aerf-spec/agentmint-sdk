// Client-side completeness checks: seq gaps, a dropped tail, and provider
// reconciliation (every model request the provider served has a receipt).

export interface Integrity {
  /** seqs 1..n present with no gaps. */
  seq_contiguous: boolean;
  missing_seqs: number[];
  /** A close receipt ends the stream. */
  close_present: boolean;
  /** Receipts before close == close.evidence.counts.receipts. */
  count_match: boolean;
  /** close.previous_receipt_hash links to the last receipt held (no dropped tail). */
  tail_ok: boolean;
  ok: boolean;
}

type R = Record<string, unknown>;

export function checkIntegrity(receipts: readonly R[], chainHash: (r: R) => string): Integrity {
  const sorted = [...receipts].sort((a, b) => Number(a.seq) - Number(b.seq));
  const seqs = new Set(sorted.map((r) => Number(r.seq)));
  const max = sorted.length ? Number(sorted[sorted.length - 1]!.seq) : 0;
  const missing: number[] = [];
  for (let s = 1; s <= max; s++) if (!seqs.has(s)) missing.push(s);
  const close = sorted.find((r) => r.action === "close:call");
  const before = close ? sorted.filter((r) => Number(r.seq) < Number(close.seq)) : sorted;
  const counts = (close?.evidence as { counts?: { receipts?: number } } | undefined)?.counts;
  const count_match = !!close && counts?.receipts === before.length && Number(close.seq) === before.length + 1;
  const last = before[before.length - 1];
  const tail_ok = !!close && !!last && close.previous_receipt_hash === chainHash(last);
  const res = {
    seq_contiguous: missing.length === 0,
    missing_seqs: missing,
    close_present: !!close,
    count_match,
    tail_ok,
    ok: false,
  };
  res.ok = res.seq_contiguous && res.close_present && res.count_match && res.tail_ok;
  return res;
}

export interface Reconciliation {
  provider_requests: number;
  matched: number;
  unmatched: string[];
}

/** Provider request log vs the request ids committed in receipts. */
export function reconcile(providerLog: readonly string[], receipts: readonly R[]): Reconciliation {
  const committed = new Set<string>();
  for (const r of receipts) {
    const ids = (r.evidence as { llm_request_ids?: unknown } | undefined)?.llm_request_ids;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") committed.add(id);
  }
  const unmatched = providerLog.filter((id) => !committed.has(id));
  return { provider_requests: providerLog.length, matched: providerLog.length - unmatched.length, unmatched };
}
