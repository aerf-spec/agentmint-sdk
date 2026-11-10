# AgentMint signing authority (Cloudflare Worker + Durable Object)

An append-only RFC 6962 transparency log for receipt leaf hashes. The signer posts a batch of leaf hashes
(`logLeafHash(signedPayloadBytes(receipt))`); the authority appends them, signs **one** STH per batch and returns
one inclusion proof per leaf. The proofs verify unchanged with the SDK's `verifyAerfReceipt(..., { logPublicKey })`.
The authority only sees hashes.

- `src/index.ts`: Worker router plus the `AuthorityLog` Durable Object (single writer, SQLite storage).
- `src/merkle.ts`: RFC 6962 root, inclusion (PATH) and consistency (PROOF/SUBPROOF) over cached complete-subtree hashes, O(log n) node reads.
- `src/crypto.ts`: WebCrypto Ed25519 and SHA-256, PEM helpers, and the canonical STH bytes.

## API (all under `/authority/v1`)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | `/key` | | `{ log_id, public_key_pem, key_id }` |
| POST | `/issuers` | `{ public_key_pem }` + `Authorization: Bearer <REGISTRATION_TOKEN>` | `{ key_id }` (first 16 hex chars of SHA-256 of the raw 32-byte key) |
| POST | `/batches` | `{ key_id, leaf_hashes[], batch_signature, batch_ts }` | `{ proofs[], sth, sth_signature, tree_size_before, tree_size_after, authority_ms }` |
| GET | `/sth` | | `{ sth, sth_signature }` (an empty log returns a signed size-0 head with root SHA-256("")) |
| GET | `/consistency` | `?from=&to=` (1 ≤ from ≤ to ≤ size) | `{ from, to, proof[] }` (RFC 6962 §2.1.2) |
| GET | `/healthz` | | `ok` |

`batch_signature` is the issuer's Ed25519 signature, in hex, over `SHA-256(concat(raw 32-byte leaf hashes) || utf8(batch_ts))`; `batch_ts` (ISO-8601 UTC) must be within ±5 min of the authority clock. Errors return
JSON `{ error }`: 400 for malformed input, 401 for a bad signature, 403 for an unknown issuer, 413 for more than 1024 leaves.
An identical batch sent again is not appended a second time. The authority returns the original proofs and STH with
`replayed: true`, so the signer can retry safely. Each batch commits in one `transactionSync`: the nodes, the STH and
the batch record are all written, or none are.

## Log key: `AUTHORITY_PRIVATE_KEY`

This is an Ed25519 private key in one of two forms:
- a PKCS8 PEM (`-----BEGIN PRIVATE KEY-----`, as written by `openssl genpkey -algorithm ed25519` or node). Literal `\n` sequences are accepted.
- 64 hex characters: the raw 32-byte seed.

`log_id` defaults to `agentmint-log-<key_id of the log key>`. Set the `LOG_ID` var to override it.

## Local (no Cloudflare login)

```sh
npm install
node scripts/gen-dev-key.mjs          # writes .dev.vars (gitignored) and prints the log public key PEM
npx wrangler@3.99.0 dev --local       # http://localhost:8787
```

## Test

The test starts `wrangler dev --local` on a random port with fresh state. It builds real receipts with the SDK
`Notary` and checks them with the SDK verifier.

```sh
cd /home/user/agentmint-sdk
npx tsx --test /path/to/authority-worker/test/authority.test.ts
# or, from this directory: npm test   (AGENTMINT_SDK overrides the SDK path)
```

## Deploy (not done yet: needs a Cloudflare API token)

```sh
export CLOUDFLARE_API_TOKEN=...            # Workers Scripts:Edit + Durable Objects
export CLOUDFLARE_ACCOUNT_ID=...
openssl genpkey -algorithm ed25519 -out authority.pem
npx wrangler@3.99.0 secret put AUTHORITY_PRIVATE_KEY < authority.pem
npx wrangler@3.99.0 deploy
curl https://agentmint-authority.<subdomain>.workers.dev/authority/v1/key   # publish this public key to verifiers
```

The first deploy applies migration `v1` (`new_sqlite_classes = ["AuthorityLog"]`). Store `authority.pem` offline.
Rotating the key starts a new log, so change `LOG_ID` when you rotate.

## Hardening

- CORS allowlist: `https://filet-demo.pages.dev`, its preview subdomains, and localhost. Preflight refuses other origins; cross-site POSTs are refused (403).
- Issuer registration requires `Authorization: Bearer <REGISTRATION_TOKEN>` (secret).
- Batches: signed `batch_ts` within ±5 min; an identical leaf set is never appended twice (returns the original proofs with `replayed: true`); ≤ 1024 leaves, ≤ 96 KB body; unknown fields rejected.
- Per-IP rate limits (RateLimiter DO, sliding 1-min window, in memory): reads 300/min, issuer registration 10/min, batches 1200/min. Service-binding calls (no CF-Connecting-IP) are not IP-limited.
