# Sample evidence packet

This folder is a worked example of what a vendor hands you. It is a real,
verifiable `evidence.zip`, not a mockup. If you received a packet from a vendor
and want to practice verifying one first, use this.

## Verify it in one command

You need Node 18 or newer, and nothing else. You do not need to install
agentmint.

```
unzip evidence.zip && node verify.mjs
```

A passing run prints one `ok` line per receipt and ends with `All checks
passed`. The full reviewer guide, including what PASS and FAIL mean, is in
[`../../FOR-REVIEWERS.md`](../../FOR-REVIEWERS.md).

## The scenario these receipts record

A prior authorization agent worked one case for the utilization management team.
Before the session began, its plan was signed: the agent could read one specific
patient's records and submit prior authorizations, but any appeal was a
checkpoint that a clinician had to clear. Every decision below became an
Ed25519-signed receipt, and each receipt is linked to the one before it.

| # | Action | Outcome | What the receipt shows |
|---|---|---|---|
| 1 | `read:patient_record:PT-4821` | Allowed | An in-scope read of the patient this session was authorized for. |
| 2 | `submit:prior_auth:PA-2210` | Allowed | A prior auth for that patient. The billed amount, 40, is within the authorized amount, 40. |
| 3 | `read:patient_record:PT-4498` | Blocked | A read of a different patient, outside the session's scope. The call was stopped and the block itself was receipted. |
| 4 | `submit:appeal:APL-1103` | Held | An appeal. The plan marks appeals as a checkpoint, so the agent could not decide it alone. |
| 5 | `approve:appeal:APL-1103` | Approved | The clinician's approval, signed with a second key. This is the human determination, recorded as its own receipt. |
| 6 | `submit:appeal:APL-1103` | Submitted | The appeal filed, under the clinician's approval from receipt 5. |

Two of the six receipts are out of policy: the blocked read (3) and the held
appeal (4). Both are included in the packet and flagged in
`receipt_index.json`. A blocked action is evidence that the boundary held, so it
belongs in the record, not hidden from it.

## What is inside evidence.zip

| File | What it is |
|---|---|
| `receipts/*.json` | The six signed receipts, one file each, in chain order. |
| `plan.json` | The signed plan that set the session's scope and checkpoints. |
| `public_key.pem` | The issuer's public key, used to check every signature. |
| `receipt_index.json` | The table of contents, chain result, and Merkle root. |
| `verify.mjs` | The standalone verifier. Node only, nothing from agentmint. |

The same `public_key.pem` is also copied next to `evidence.zip` in this folder,
so you can inspect the key without unzipping.

## How to map a control to a receipt field

See [`../../docs/compliance-crosswalk.md`](../../docs/compliance-crosswalk.md).
It lists, control by control, which receipt field answers the question and how
to check it in this packet.

## Regenerating this packet

The packet is produced deterministically from fixed keys and fixed timestamps,
so rebuilding it yields a byte-identical `evidence.zip`:

```
npm run packet:sample
```

The scenario and the generator live in
[`generate.ts`](generate.ts). The signing keys it uses are throwaway demo keys
derived from constant seeds. They exist only so the sample can be rebuilt, and
they secure nothing.
