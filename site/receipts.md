# Prior authorization session PA-2210: receipts

Sample data. No real patient information. Identifiers, amounts, and the payer name are fictional. The signatures and hashes are real, computed by the SDK over this synthetic session.

| | |
| --- | --- |
| Agent | `prior-auth-agent` |
| Payer | Northgate Health Plan (example) |
| Plan issued | 2026-01-15 09:00:00 UTC |
| Signing key | `c770accea5578c92` |
| Authorized scope | `read:patient_record:PT-4821:*`, `submit:prior_auth:*` |
| Checkpoints | `submit:appeal:*` |
| Receipts | 6 |
| Chain root | `2093f65124f37dc4ef9bc688d211ad0e8b842fa4b8187f1e3795a90498197e6d` |

The same receipts in other formats:

- Raw signed JSON: [receipts.json](./receipts.json)
- Verification report: [verification.md](./verification.md)
- Public key: [public_key.pem](./public_key.pem)

---

## Receipt 1: Allowed

**Patient record read.** The agent read the record for the patient assigned to this case, PT-4821. This is inside the authorized scope, so it ran and was recorded.

- Action: `read:patient_record:PT-4821`
- Status: Allowed
- In policy: `true`
- Recorded: 2026-01-15 09:00:01 UTC
- Sequence number: 1
- Receipt id: `a1000001-0000-4000-8000-000000000001`
- Policy reason: In scope for this case. HIPAA 164.312(a) access control is satisfied for the assigned patient.
- Evidence: `{"patient_id":"PT-4821"}`
- Issuer signature (Ed25519): `eb9b2cfb2c0d34c55d9edb6bc280f03931b52fdcdaae53008ea8da77c0b7eb0f69b911ab3cdb59aaaaf88aed82175c50f1c919b8cb2d6b1d9377012423275c0a`
- Previous receipt hash: `none (first receipt in the chain)`
- Evidence hash (SHA-512): `81b1d1844bffca59a46c8437d2b44e275787666ad147c669ed9b1749645ad2c32bff97fe72ae2862db42c98cb45a705100ebcc5be058e5c7250f4f43b122f069`

---

## Receipt 2: Allowed

**Prior authorization submitted.** The agent submitted prior authorization PA-2210. The billed amount matched the authorized amount from the lookup, so it stayed in scope.

- Action: `submit:prior_auth:PA-2210`
- Status: Allowed
- In policy: `true`
- Recorded: 2026-01-15 09:00:02 UTC
- Sequence number: 2
- Receipt id: `a2000002-0000-4000-8000-000000000002`
- Policy reason: In scope. Billed amount 40 does not exceed the authorized amount 40 from the lookup.
- Evidence: `{"auth_id":"PA-2210","billed_amount":40,"authorized_amount":40}`
- Issuer signature (Ed25519): `90a02e835f643879a43d901e4fb79ee8481829c0562147e16ab4aefda385d8a4b7f8f912ec11ac299ef329c65dc00a5dd5ac96c3f93c4fb544fc0f41b275c50d`
- Previous receipt hash: `b56f6a7df00994feeeafb31bcc1a69035c60b7aa3ecdff0bf9194465eaad0837`
- Evidence hash (SHA-512): `d2478cb8d94b22cbea308ed4ecd65b37c79eaa3decda9dfbfc26df18b83971a0e50ddeda761dd3cb390c34dc6d629401190352de21e9584b9a723282186c0485`

---

## Receipt 3: Blocked

**Out-of-scope record read blocked.** The agent tried to read a different patient's record, PT-4498. That record is outside this session's authorized scope, so the call was blocked before it ran. The block itself is recorded.

- Action: `read:patient_record:PT-4498`
- Status: Blocked
- In policy: `false`
- Recorded: 2026-01-15 09:00:03 UTC
- Sequence number: 3
- Receipt id: `a3000003-0000-4000-8000-000000000003`
- Policy reason: Out of scope. This record is not the assigned patient, so the call was blocked before it ran.
- Evidence: `{"patient_id":"PT-4498","blocked":true}`
- Issuer signature (Ed25519): `2ed3878500b14ad0bc30146e963f5861bfd715a4a41de709f2854114390ce572c5733345796f899a328cbe143156fd478d75748d14f881faa9910acc025b970c`
- Previous receipt hash: `f5c89973f02b6ecfa2681b6fa401e3bcc2e6d9c1ec0d0bef3c584e04ea5260c9`
- Evidence hash (SHA-512): `205986d7794be70a80687dcf12e175d94b0aa07bc63376311d5221a95983e048af4ee872730a0a7d1370b72dc861d64dc7fd623a9a57412ff0d853ee7cd3aa07`

---

## Receipt 4: Checkpoint

**Appeal held for clinician approval.** The agent reached an appeal. Under CMS-4201-F and California SB 1120 a clinician, not an algorithm, has to make this determination, so the action was held at a checkpoint.

- Action: `submit:appeal:APL-1103`
- Status: Checkpoint
- In policy: `false`
- Recorded: 2026-01-15 09:00:04 UTC
- Sequence number: 4
- Receipt id: `a4000004-0000-4000-8000-000000000004`
- Policy reason: Held for human approval. CMS-4201-F and California SB 1120 require a clinician to make this determination.
- Evidence: `{"appeal_id":"APL-1103","held":true}`
- Issuer signature (Ed25519): `e46d61c298f2c08abd45a9fd42f729d719ddc321790f4067de701853d3b87aa12347781cd8ae857afcec5a02e92d0708e598c3a5fc59689306888b0b50ad140d`
- Previous receipt hash: `b099d3a034f307e5ce7828889893620965846881b1da94d50da393869568d789`
- Evidence hash (SHA-512): `abeeaebc76e70dde8c5689fd12e82cc0ee4edd37202433527ad26b64b43a3e59f0ae86f6d982beaa737990ee0fb65a4443c9eac6af91279875e9f0124e002787`

---

## Receipt 5: Approved

**Clinician approval recorded.** A clinician reviewed the appeal and approved it. The approval is its own signed receipt in the chain, carrying the clinician key that authorized it.

- Action: `submit:appeal:APL-1103`
- Status: Approved
- In policy: `true`
- Recorded: 2026-01-15 09:00:05 UTC
- Sequence number: 5
- Receipt id: `a5000005-0000-4000-8000-000000000005`
- Policy reason: Approved by clinician key 4f2a. The clinician's determination is now a signed artifact in the chain.
- Evidence: `{"appeal_id":"APL-1103","approved_by":"clinician:4f2a"}`
- Issuer signature (Ed25519): `12feecc487b0e9b2cfcc8d455849300662d4a06099c28922b447ab7d6f369cf84a892e4b35a2b2ba00464b8baad73b387915fc1f6681597ffa8eb9cc5364cd0b`
- Previous receipt hash: `80b227abc8efdee3d4f92f1cff5b6437aec29b24e88b7d3f9fda8e9b6450aa88`
- Evidence hash (SHA-512): `6ac2854dfc32e3ece5c7131ed69f5ea7de8c10758398ee2a53cd15c285db9393fb9e7b3a237f7411e297fbab26b82833900c4c16aa562423db58ada925bfaaec`

---

## Receipt 6: Submitted

**Appeal submitted under approval.** The appeal was submitted, and only after the clinician approval was in place. The receipt records that the clinician's decision, not the agent's, authorized the submission.

- Action: `submit:appeal:APL-1103`
- Status: Submitted
- In policy: `true`
- Recorded: 2026-01-15 09:00:05 UTC
- Sequence number: 6
- Receipt id: `a6000006-0000-4000-8000-000000000006`
- Policy reason: Submitted under the clinician's approval. The clinician's decision, not the agent's, is on the receipt.
- Evidence: `{"appeal_id":"APL-1103","submitted":true}`
- Issuer signature (Ed25519): `79418771ad3e76d8c8afe2634473ce4b7ecd7f928ec8e4ddd2abf938cfa0f52cd0dc1507145edccb239bf7c84e0b5ec13212de4af767fb4555ebcb976ef3f80a`
- Previous receipt hash: `9075731d760f4c8a6a208b444be65b9415f1011cad5bd9ba8fd2cb7fcdce50f0`
- Evidence hash (SHA-512): `3ea2136fa0a20ae8c33de888a1f1d2364d8d8bc3980b3e6c473e373234b556d3159bd996c28fdf0f15f86f1add0f00168c040ca690e3df3e0f25fd4e427824d6`

---

## Verify these yourself

You do not have to trust this file. The same receipts are in a downloadable evidence packet, byte for byte the same. Check them with Node and nothing else.

```
git clone https://github.com/aerf-spec/agentmint-sdk
cd agentmint-sdk/examples/sample-evidence-packet
unzip evidence.zip -d packet
node packet/verify.mjs
```

