# Threat model

What agentmint receipts defend against, what they do not, and where each
claim is tested. Every "detected" below names the test that proves it.
Vector paths are under `test/vectors/`; the oracle
(`node test/aerf-verify-poc.mjs`) checks all 12.

## Trust boundary: the gate process

```
 agent (LLM)          gate (this SDK, in your process)          tool
 ──────────►  policy check → sign receipt → chain link  ──────►  runs
                              │
                              ▼
                signed, hash-chained receipts
                (verifiable offline, later, by anyone with the public key)
```

The gate runs inside the application process that holds the signing key.
That placement is the boundary. Everything downstream of signing is
protected: a signed receipt cannot be altered, and a chained receipt
cannot be removed, without detection. Everything upstream of signing is
trusted at signing time: a host that is fully compromised before the
signature exists, or that controls the signing key, can sign a lie. The
gate proves integrity after emission. It does not prove the honesty of
the emitter.

## What a signed receipt proves

- This decision (action, params hash, in_policy verdict, reason) was
  recorded by the holder of this key, under the policy identified by
  `policy_hash`, and no signed field changed after signing.
- The chain proves completeness: each receipt carries a signed
  `previous_receipt_hash` and a signed monotonic `seq`, so a removed or
  reordered receipt breaks the chain at a named index, two independent
  ways (`test/silence.test.ts`, vector `04-tamper-chain`).
- The evidence bundle's index carries the chain root, and optionally a
  signed root commitment, so an auditor can pin the whole set
  (`src/evidence.test.ts`).

## What it does not prove

- That the policy was correct or sufficient. A receipt under a bad policy
  is a faithful record of a bad decision.
- That the agent was not manipulated upstream. If a jailbroken model asks
  for an in-scope action, the receipt honestly records an in-scope action.
- That the tool did what it claimed. The receipt records the call and the
  declared result, not ground truth about the side effect.
- Freshness by itself. Receipts carry timestamps and seq, but proving "this
  is the latest chain" requires the consumer to anchor the chain root
  externally (publish it, or compare against the signed root commitment in
  the evidence bundle).

## Attacker model

| Attack | Detected? | How, and where it is tested |
|---|---|---|
| Edit a signed field of a receipt | Yes | Ed25519 signature over the canonical stripped payload fails. `test/silence.test.ts` (b), `test/demos.test.ts` (tamper), property test over every field: `test/property.test.ts`, vector `03-tamper-evidence` |
| Delete a receipt from a chain | Yes | Hash link breaks and the signed seq gaps, at the same index. `test/silence.test.ts` (c), `src/chain.test.ts` ("deletion", "seq_gap"), vector `04-tamper-chain` |
| Forge a decision without the key | Yes | No valid signature can be produced; verification fails. Oracle vectors `03`, `04`; `src/chain.test.ts` ("signature_invalid") |
| Replay a receipt | Partially | Within a plan chain, position is pinned by signed seq plus `previous_receipt_hash`, and a receipt inserted at genesis is a `genesis_violation` (`src/chain.test.ts`). Replaying an entire valid chain as if current is not detectable from the receipts alone; anchor the chain root externally (see above) |
| Swap the policy after the fact | Yes | Receipts bind `plan_id`, `plan_signature`, and `policy_hash` (SHA-256 of canonical scope/checkpoints/delegates_to). A different policy yields a different hash, and the plan itself is signed (`src/plan.test.ts`, including the cross-producer match "matches the Python producer's _compute_policy_hash") |
| Steal the signing key | No | A stolen issuer key signs valid receipts. The receipt layer cannot detect this; it can only raise the bar (multi-signer, below). Key custody, rotation, and HSMs are the host's job |
| Lie to the gate before signing | No | Vector `12-common-mode-known-limit`: if every signer saw the same poisoned input, all sign honestly. AERF records what was observed, not what should have been |

## Multi-signer defenses (why one stolen key is not enough)

For actions marked with `impact_tags` (HIGH-IMPACT in SPEC §17), a valid
issuer signature alone is not sufficient:

- The parent counter-signature must cover exactly the bytes the issuer
  signed (SPEC §16.3). A counter-signature over different content is
  rejected (`test/aerf-multisigner.test.ts`: "REJECTS a parent
  counter-signature over different content", vectors `05`, `06`).
- The PDP (policy decision point) signature covers the canonical tuple
  `{context_hash_sha256, in_policy, policy_hash}` with an independent key,
  so the verdict is bound to the context it was issued for. A verdict
  signed for a different context is rejected (vectors `07`, `08`).
- The C-12 property: with `impact_tags` non-empty, a receipt missing
  either the parent or the PDP signature fails verification, so an
  attacker holding only the issuer key cannot mint a HIGH-IMPACT
  `in_policy: true` receipt (`test/aerf-multisigner.test.ts`: "C-12
  defense").
- Optional log inclusion proofs (RFC 6962) bind a receipt into an
  append-only log with a separately keyed root signature (vectors `09`,
  `10`; `src/merkle.test.ts`).

The residual, stated plainly: an attacker who controls the agent process
can strip `impact_tags` before issuance, and the verifier cannot know the
tags were ever intended. That is vector `11-tag-stripped-known-limit`; the
defense is upstream tag pinning at the policy enforcement point, outside
this SDK.

## Known enforcement limits (the gate, not the receipts)

These are limits of the policy gate's rule matching, separate from the
receipt cryptography. Each is pinned by a test so the behavior is at least
explicit:

- Nested-payload smuggling. Input rules match top-level parameters, and
  pattern rules match string values (`src/kernel/cross-ref.ts`). A blocked
  value buried inside a nested object or array is not matched by
  `blocked_patterns`/`blocked_values`. Keep sensitive parameters top-level
  and scalar. Related: the redactor treats nested objects wholesale
  (`src/kernel/redact.test.ts`: "object_redacted").
- Omitted bind. `bind` pins a parameter's value when the parameter is
  present; a call that omits the parameter entirely passes the bind check
  (`src/experimental/enforce.test.ts`: "bind_ignores_absent"). Pair bind
  with a `requires` or schema-level check if absence matters.
- Near-identical loop variants. The loop breaker counts identical
  (tool, args-hash) calls. An agent that perturbs one byte per retry does
  not trip it (`src/experimental/breakers.test.ts`: "ignores calls with
  different args"). The velocity breaker (calls per window, any args) is
  the intended backstop.
- Multi-entity cross-ref. `cross_ref`/`max_ref` compare against the most
  recent output of the referenced tool. If the referenced tool was never
  called there is nothing to compare, and no violation fires
  (`tests/integration.test.ts`: "cross_ref with uncalled tool produces no
  violation"). Combine with `requires` to force the lookup first, as the
  demo spec does.

## Reporting

If you can make a receipt lie, make a deletion invisible, or bypass a rule
in a way not listed above, that is a bug. Open an issue with a failing
vector or test; see CONTRIBUTING.md.
