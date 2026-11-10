// Leak scan: no visible string may share a 6-word sequence with the private
// prompt. Words are lowercased and stripped to letters/digits. Fails closed:
// a streaming guard holds back the last 5 words until it knows they cannot
// complete a leaking 6-gram.

const N = 6;

function words(text: string): { norm: string; start: number; end: number }[] {
  const out: { norm: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const norm = m[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (norm) out.push({ norm, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

export class LeakScanner {
  private grams = new Set<string>();
  constructor(secret: string) {
    const w = words(secret).map((x) => x.norm);
    for (let i = 0; i + N <= w.length; i++) this.grams.add(w.slice(i, i + N).join(" "));
  }
  get size(): number {
    return this.grams.size;
  }
  /** First leaking 6-gram in `text`, or null. */
  find(text: string): string | null {
    const w = words(text).map((x) => x.norm);
    for (let i = 0; i + N <= w.length; i++) {
      const g = w.slice(i, i + N).join(" ");
      if (this.grams.has(g)) return g;
    }
    return null;
  }
  /** Scan every string inside a JSON value. */
  findIn(value: unknown): string | null {
    if (typeof value === "string") return this.find(value);
    if (Array.isArray(value)) {
      for (const v of value) { const f = this.findIn(v); if (f) return f; }
      return null;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) { const f = this.findIn(v); if (f) return f; }
      // Also across concatenated strings, so a phrase split over fields is caught.
      return this.find(collectStrings(value).join(" "));
    }
    return null;
  }
  stream(): StreamGuard {
    return new StreamGuard(this);
  }
}

function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => collectStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectStrings(x, out));
  return out;
}

export class StreamGuard {
  private full = "";
  private emitted = 0;
  leaked: string | null = null;
  constructor(private scanner: LeakScanner) {}

  /** Append text; returns the newly safe-to-emit text ("" if none), or null once leaked. */
  push(text: string): string | null {
    if (this.leaked) return null;
    this.full += text;
    const w = words(this.full);
    const trailingOpen = !/\s$/.test(this.full);
    const complete = trailingOpen ? w.slice(0, -1) : w;
    const hit = this.scanner.find(complete.map((x) => x.norm).join(" "));
    if (hit) { this.leaked = hit; return null; }
    // Words that may still join a future 6-gram: the last N-1 complete words (+ the open one).
    const settled = complete.length - (N - 1);
    if (settled <= 0) return "";
    const safeEnd = complete[settled]?.start ?? (trailingOpen ? w[w.length - 1]!.start : this.full.length);
    if (safeEnd <= this.emitted) return "";
    const out = this.full.slice(this.emitted, safeEnd);
    this.emitted = safeEnd;
    return out;
  }

  /** End of stream: final check, returns the remainder or null if leaked. */
  flush(): string | null {
    if (this.leaked) return null;
    const hit = this.scanner.find(this.full);
    if (hit) { this.leaked = hit; return null; }
    const out = this.full.slice(this.emitted);
    this.emitted = this.full.length;
    return out;
  }
}
