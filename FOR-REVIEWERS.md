# For reviewers: verifying an evidence packet

You received a file called `evidence.zip` from a vendor. This page explains how
to check it yourself, on your own machine, in about a minute. You do not need to
be a developer, and you do not need to trust the vendor's word for what their
agent did.

You do not need to install agentmint, or anything from the vendor, to verify a
packet. The only requirement is Node 18 or newer, which you very likely already
have. Nothing else.

## What is in the packet

Unzipping `evidence.zip` gives you a small set of files:

- **The receipts** (`receipts/*.json`). One signed receipt per action the agent
  took. Each records what the action was, when it happened, whether it was
  allowed under the vendor's policy, and the reason. Each receipt is signed and
  carries the fingerprint of the receipt before it, so the set forms a chain.
- **The signed plan** (`plan.json`). The policy the session ran under: what the
  agent was allowed to do, and which actions required a human to approve them.
  It is signed too, so it cannot be swapped out after the fact.
- **The public key** (`public_key.pem`). The key that checks every signature.
  Signatures were made with the vendor's private key, which they hold and you
  never see. The public key only lets you verify; it cannot create a receipt.
- **The standalone verifier** (`verify.mjs`). A single short script that does
  the checking. It uses only Node's built-in cryptography. It does not call the
  vendor, it does not call us, and it does not go online.
- **The index** (`receipt_index.json`). A plain table of contents listing every
  receipt, plus the chain's root fingerprint.

## The one command

Open a terminal, go to the folder where you saved the file, and run:

```
unzip evidence.zip && node verify.mjs
```

That unpacks the packet and runs the verifier. There is nothing else to set up.

## What PASS means

A passing run prints one `ok` line for the plan, one `ok` line for each receipt,
one `ok` line for the chain root, and ends like this:

```
  ok    plan signature
  ok    signature  c0000000  read:patient_record:PT-4821
  ok    signature  c0000000  submit:prior_auth:PA-2210
  ok    signature  c0000000  read:patient_record:PT-4498
  ok    signature  c0000000  submit:appeal:APL-1103
  ok    signature  c0000000  approve:appeal:APL-1103
  ok    signature  c0000000  submit:appeal:APL-1103
  ok    chain root 4d7ac49c0a162b2f...

All checks passed: 6 receipt(s), chain intact.
```

When you see `All checks passed`, three things are true at once:

1. **Every receipt signature holds.** Each receipt was signed by the holder of
   the private key, and not one signed field has been changed since. If anyone
   edited an amount, a patient id, a timestamp, or a verdict, the signature on
   that receipt would no longer match.
2. **The chain is unbroken.** Each receipt names the exact fingerprint of the
   one before it, and the sequence numbers run without a gap. If a receipt had
   been removed or reordered, the link would not line up.
3. **Nothing was altered or deleted after signing.** The two checks above,
   taken together, mean the record you are looking at is the record that was
   created at the time, in the order it was created.

The verifier exits with code 0 on a pass, so it also works inside a script or a
pipeline if you want to automate the check.

## What FAIL looks like

If anything was changed, the verifier says so and names the exact receipt. For
example, if someone had edited the billed amount on the prior auth receipt from
40 to 500, the run would read:

```
  ok    plan signature
  ok    signature  c0000000  read:patient_record:PT-4821
  FAIL  signature INVALID for c0000000-0000-4000-8000-000000000002
  ok    signature  c0000000  read:patient_record:PT-4498
  FAIL  chain link broken at c0000000-0000-4000-8000-000000000003 (a receipt was removed or reordered)
  ok    signature  c0000000  submit:appeal:APL-1103
  ...

2 check(s) FAILED
```

The `FAIL` line points straight at the receipt whose signature no longer
matches, by its full id. Because every later receipt is chained to that one, the
break also shows up as a broken link at the next receipt, so you can see exactly
where the record stopped being trustworthy. A failing run exits with code 1.

If verification fails, the honest reading is simple: the packet in your hands is
not the packet that was signed. Ask the vendor for the original, and treat the
altered copy as unproven.

## What a receipt does not prove

A passing packet is strong evidence, and it is important to be clear about its
edges. The following is drawn from the project's
[threat model](THREAT-MODEL.md), which states these limits in full.

A receipt proves what was observed and signed, not what should have happened. It
does not prove the vendor's policy was correct or sufficient: a faithful receipt
under a bad policy is still a faithful record of a bad decision. It does not
prove the agent was free of manipulation upstream: if a compromised model
requested an in-scope action, the receipt honestly records an in-scope action.
It does not prove the tool did what it claimed: the receipt records the call and
the declared result, not the real-world side effect. And a valid packet, on its
own, does not prove it is the most recent one; to rule out an old but genuine
chain being presented as current, anchor the chain root against a copy you
receive and record independently. What a receipt does make impossible is silent
revision: no field can be changed, and no action can be dropped, without the
verification you just ran failing and naming where.

## Mapping receipts to your controls

If you are checking the packet against a specific control, such as HIPAA access
controls or the clinician determination requirement, see the
[compliance crosswalk](docs/compliance-crosswalk.md). It lists, for each
control, the question you are asking, the receipt field that answers it, and how
to confirm it in the packet.

## Try it on the sample

If you would like to see a real passing packet before you verify the vendor's,
this repository ships one at
[`examples/sample-evidence-packet/`](examples/sample-evidence-packet/). It is a
prior authorization session with the same shape as the transcripts above. Unzip
its `evidence.zip` and run `node verify.mjs` exactly as here.
