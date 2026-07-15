/**
 * @kernel
 * Part of the AgentMint verification kernel. The wedge (receipt/verify/gate)
 * depends on this module, so it must never be made optional, bypassable, or
 * relocated to experimental/. Kernel modules must not import from experimental/.
 *
 * By default this is a heuristic: bound keys pass through, long strings and
 * objects are replaced with [REDACTED], and short scalars pass through. When an
 * `allow` list is given, it is a strict allowlist instead: only the keys in
 * `allow` (plus bound keys) are kept, and every other key is redacted whatever
 * its type. Use the allowlist when you want to guarantee that only chosen
 * identifiers reach a receipt, so clinical payloads never land in evidence.
 */
export function redact(
  params: Record<string, unknown>,
  boundKeys: readonly string[],
  allow?: readonly string[],
): Record<string, unknown> {
  const boundSet = new Set(boundKeys);
  const allowSet = allow ? new Set(allow) : undefined;
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      if (boundSet.has(key)) return [key, value];
      if (allowSet) return allowSet.has(key) ? [key, value] : [key, "[REDACTED]"];
      if (typeof value === "string" && value.length > 50) return [key, "[REDACTED]"];
      if (typeof value === "object" && value !== null) return [key, "[REDACTED]"];
      return [key, value];
    }),
  );
}
