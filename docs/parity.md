# Python parity

Status of every capability in the Python reference producer's `__all__`
(`agentmint` 0.2.x, vendored at `.vendor/agentmint-python`), the wire-format
compatibility guarantees between the two producers, and the design of the
failure→regression-test loop.

Legend: **done** = ported with matching semantics · **exceeded** = ported and
strengthened · **omitted** = deliberately not ported, with the reason.

## Capability map

| Python (`__all__`) | TS | Status |
|---|---|---|
| `Notary` | `Notary` (`src/notary.ts`) | **exceeded**: per-plan chain isolation and persistent state like Python, plus a signed monotonic `seq` per chain and the SPEC §8.4 chain rule (see below) |
| `PlanReceipt`, `Plan` | `PlanReceipt`, `signPlan`/`verifyPlan`/`buildPlan` (`src/plan.ts`) | **done**: byte-identical signable dict, TTL clamping, never-expires sentinel |
| `NotarisedReceipt` | `AerfReceipt`, `buildAerfReceipt` (`src/receipt-aerf.ts`) | **exceeded**: same signable field-inclusion conditions (cross-producer byte-match test), plus the AERF v0.2 multi-agent fields Python does not emit yet (`impact_tags`, `context_hash_sha256`, `pdp_signature`/`pdp_key_id`, `parent_signature`/`parent_key_id`, `log_inclusion_proof`, serialized `agent_signature`) |
| `EvidencePackage` | `EvidencePackage` (`src/evidence.ts`), `agentmint export` | **exceeded**: portable zip with plan, receipts, index (chain root + signed root commitment + RFC 6962 Merkle root), and a **standalone Node verifier** (`verify.mjs`, node:crypto only) that checks signatures, chain links, and seq. Python bundles an OpenSSL timestamp checker + a pynacl signature checker instead |
| `verify_chain` | `verifyAerfChain` (`src/chain.ts`) | **exceeded**: reports `valid/length/rootHash/breakAtIndex/reason` like Python, and additionally distinguishes four break types (`signature_invalid`, `hash_link_mismatch`, `seq_gap`, `genesis_violation`) and verifies signatures in the same pass |
| `verify` | `verifyAerfReceipt` (`src/receipt-aerf.ts`), `verify` (`src/verify.ts`) | **exceeded**: full multi-signer verification (issuer, agent, parent, PDP, log inclusion) matching the Go reference verifier; reproduces all 12 conformance vectors |
| `EnforceMode` | `AerfMode` + `mode` on `Notary`/`harden()` | **done**: `enforce`/`shadow`/`warn` with `original_verdict` preserved on the receipt exactly like Python |
| `intersect_scopes`, delegation | `intersectScopes`, `delegatePlan`, `Notary.delegateToAgent`, `auditTree` | **done** |
| `FileSink`, `Sink` | `ReceiptSink`, `FileReceiptSink` (`src/notary.ts`) | **done**: sink failures isolated from issuance, like Python |
| `ConsoleOTelSink` | (none) | **omitted**: an OTel exporter would break the zero-runtime-dependency constraint; `ReceiptSink` is a two-line interface, so any exporter can be plugged in by the app |
| `CircuitBreaker`, `BreakerResult` | spec-driven breakers (`src/experimental/breakers.ts`) | **partial by design**: loop/velocity/cost/budget breakers run pre-flight at the tool boundary; Python's per-agent sliding-window failure breaker is not ported because the TS wedge keys enforcement on tools and plans, not agent reputations |
| `scan`, `ShieldResult`, `Threat` | `agentmint scan` CLI + `src/experimental/scan` | **partial by design**: TS scan generates a spec from tool source; Python's Shield content scanner (PII/secret patterns) is out of the wedge. The `redact` kernel module strips unbound sensitive params from receipts instead |
| `notarise` (decorator) | `harden()` | **exceeded**: Python decorates one function at a time; `harden()` wraps a whole tool set (raw/OpenAI/Anthropic/LangChain/Vercel shapes) with the same one-line ergonomics, plus spec rules, breakers, budget guardrails, plan policy, and signed decision receipts |
| `AgentMint`, `Receipt`, `JtiStore` | (none) | **omitted**: the legacy pre-notary authorization-token API (JWT-style claims, single-use JTIs). Its job (pre-flight authorization with expiry and replay protection) is covered by plans (`signPlan`/`evaluatePolicy` with TTL) and `gate()` hash-chained approvals |
| `require_receipt`, `set_receipt`, `get_receipt`, `clear_receipt` | (none) | **omitted**: contextvar plumbing for the legacy decorator; `gate()` and `config.checkpoint` cover the pre-flight approval flow |
| `AgentMintError` and subclasses | `AerfReceiptError` + per-module errors | **done in spirit**: TS keeps error types close to their modules rather than a central hierarchy |
| RFC 3161 timestamping (`timestamp.py`) | (none) | **omitted**: issuance-time network calls to a TSA are out of scope for a zero-dependency SDK; the receipt shape reserves the post-issuance `timestamp` field (SPEC §11), so tokens can be attached by an outer layer without breaking signatures or chains |

## Wire-format compatibility guarantees

Everything below is enforced by tests that run against the vendored Python
producer (`test/cross-producer*.test.ts`, `src/plan.test.ts`,
`src/chain.test.ts`) and the conformance vectors (`test/aerf-*.test.ts`,
oracle: `node test/aerf-verify-poc.mjs`, 12/12).

- **Canonical JSON**: RFC 8785 (JCS) with NFC-normalized strings, raw UTF-8,
  keys sorted by code point. The producer path throws on non-integer numbers
  (JS cannot round-trip `1250.0`); the verifier path replays number lexemes
  verbatim from source bytes, like Go's `json.Number`. Fuzzed byte-identical
  against `python3 json.dumps(sort_keys=True, separators=(",",":"))`.
- **Signatures**: Ed25519 over the canonical payload minus the post-issuance
  fields (`signature`, `timestamp`, `parent_signature`, `parent_key_id`,
  `log_inclusion_proof`). The same logical receipt built here and by the
  Python producer from the same seed yields identical canonical bytes and
  identical signatures, each verifiable by the other side.
- **key_id**: first 16 lowercase hex chars of SHA-256 of the raw 32-byte
  public key; matches Python's `_derive_key_id` for the same seed.
- **policy_hash**: SHA-256 of canonical `{scope, checkpoints, delegates_to}`;
  matches Python's `_compute_policy_hash` for the same plan.
- **Chain hash (one deliberate divergence)**: `previous_receipt_hash` here is
  the SPEC §8.4 hash of the **stripped** canonical payload (no signature), as
  the conformance vectors require. The Python producer hashes the payload
  *including* the signature. Where they conflict, the spec wins.
  `verifyAerfChain(..., { acceptLegacyLinks: true })` verifies Python-produced
  chains and reports which rule linked them; both verifiers flag a removed
  receipt at the same index on shared fixtures.
- **Merkle**: RFC 6962 domain separation (`0x00` leaf / `0x01` interior),
  largest-power-of-two-below-n split, no padding. Roots and audit paths are
  byte-identical to the reference primitives (`tools/aerf_primitives.py`).
  Proof verification follows RFC 9162 §2.1.3.2 exactly; the Go verifier's
  right-edge promote branch (which consumes a path entry without hashing it)
  is a known deviation on its side, never exercised by the vectors.
- **Multi-signer semantics**: parent counter-signature over exactly the
  issuer-signed bytes (§16.3), PDP signature over the canonical
  `{context_hash_sha256, in_policy, policy_hash}` tuple (§17), both REQUIRED
  when `impact_tags` is non-empty. A valid issuer signature alone cannot carry
  a HIGH-IMPACT `in_policy: true` claim (C-12). All 12 vectors reproduce.

## The failure→regression-test loop

The loop turns a captured incident into a policy, a regression suite, and a
guard against future policy edits:

1. **Capture.** Every `enforce()` denial carries a structured `violations[]`
   array (rule type, field, expected, actual, rule ref) on the event, the
   JSONL line, and the signed decision receipt: inference never re-parses
   human-readable strings for corpora produced by this SDK.
2. **Infer** (`agentmint learn --from receipts/`). Every rule type maps back
   to spec YAML: `requires`, `cross_ref`, `max_ref`, `blocked_pattern`,
   `blocked_value`, loop/velocity/cost breakers, `budget_cap`, `usage_cap`,
   `cost_cap`, `action_block` (and `bind_violation`, noted but config-level).
3. **Generate** (`--test`). A hermetic vitest file that replays the exact
   recorded call sequence against stub tools, with cross-ref/max-ref state
   seeded from the recorded violations so stateful rules re-fire
   deterministically. Denials are clustered by `(tool, rule, field)`: fifty
   receipts tripping one rule produce one representative test. The header
   carries the source corpus path and its SHA-256.
4. **Check** (`--check <policy>`). Replays the corpus against an edited
   policy and exits non-zero if any previously-caught failure would now
   execute: the reopened-hole detector, made for CI.
5. **Repair** (`--repair <policy>`). When the corpus shows failures the
   current policy misses, writes the merged policy and prints the added
   rules, each annotated with the run id and timestamp of the receipt it was
   learned from.

`npm run demo:learn` runs the whole loop end to end, including `--check`
catching a deliberately holed policy with exit 1.
