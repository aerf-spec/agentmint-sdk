# Verification report: prior authorization session PA-2210

Sample data. No real patient information. Identifiers, amounts, and the payer name are fictional. The signatures and hashes are real, computed by the SDK over this synthetic session.

This report was produced by the SDK verifier (`verifyAerfChain`) over the receipts in [receipts.json](./receipts.json). Every line below is the verifier's own result, not a description of it.

## Clean chain

All checks pass. Every signature is valid, every receipt's recorded link matches the receipt before it, and the sequence runs with no gaps.

```
  ok    signature  seq 1  read:patient_record:PT-4821
  ok    signature  seq 2  submit:prior_auth:PA-2210
  ok    signature  seq 3  read:patient_record:PT-4498
  ok    signature  seq 4  submit:appeal:APL-1103
  ok    signature  seq 5  submit:appeal:APL-1103
  ok    signature  seq 6  submit:appeal:APL-1103
  ok    chain root 2093f65124f37dc4ef9bc688d211ad0e8b842fa4b8187f1e3795a90498197e6d

  PASS: 6 receipt(s), chain intact.
```

## Tamper check

One field on receipt 3 (`in_policy`) was changed from `false` to `true` after it was signed, to make the blocked read look as though it had been allowed. Nothing else was touched. The same verifier was run again.

```
  chain invalid
  break at receipt 3 (id a3000003-0000-4000-8000-000000000003)
  type: signature_invalid
  receipt [2]: signature verification failed, a signed field was tampered
  changed field: in_policy  false -> true

  FAIL: verification stops at receipt 3.
```

The check names the exact receipt and does not need to be told where to look. Every receipt after the changed one is also flagged, because each receipt is linked to the one before it.

## Reproduce this

```
git clone https://github.com/aerf-spec/agentmint-sdk
cd agentmint-sdk/examples/sample-evidence-packet
unzip evidence.zip -d packet
node packet/verify.mjs
```

A pass prints `All checks passed: 6 receipt(s), chain intact.` and exits 0.

