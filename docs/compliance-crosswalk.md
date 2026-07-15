# Compliance crosswalk

This table maps common controls to the receipt fields that answer them, so a
reviewer can go from a control on their checklist to the exact place in an
evidence packet that satisfies it. The field names below are the ones you will
see inside each `receipts/*.json` file and in `plan.json`. The
[sample packet](../examples/sample-evidence-packet/) is a good place to try
each check.

Every check runs against a packet you have already verified with
`node verify.mjs`. Verification is what makes the fields trustworthy in the
first place: it confirms nothing was altered or deleted after signing. The
checks below then read specific fields to answer specific control questions.

| Control | What the reviewer asks | Receipt fields that answer it | How to check it in the packet |
|---|---|---|---|
| HIPAA 164.312(a), access control | Was access to protected health information limited to what this session was authorized for? | Plan `scope` and `checkpoints`; per receipt `action`, `in_policy`, `policy_reason` | Open `plan.json` and read `scope` to see which patient and actions were allowed. Then confirm every receipt with `in_policy: false` is an access that was stopped, such as the read of a patient outside scope, and that its `policy_reason` names why. |
| HIPAA 164.312(b), audit controls | Is there a tamper-evident record of activity on systems holding protected health information? | Per receipt `action`, `agent`, `observed_at`, `seq`, `previous_receipt_hash`, `signature` | A green `node verify.mjs` run is the answer: every `signature` holds and the `previous_receipt_hash` links and `seq` numbers run without a gap, so no entry was changed, removed, or reordered after the fact. Read `observed_at` and `action` on each receipt to review the activity itself. |
| Clinician determination (CMS-4201-F final rule; California SB 1120) | Did a human clinician, not an algorithm, make the coverage or appeal determination? | The checkpoint receipt (`in_policy: false`, `policy_reason` naming the checkpoint) followed by an approval receipt carrying `agent`, `agent_key_id`, `agent_signature`, and an `evidence.determination` | Find the appeal held as a checkpoint, then the following receipt where `evidence.determination` is `approved`. Confirm it carries an `agent_signature` and an `agent_key_id` distinct from the issuer `key_id`, which shows the approval was signed by the clinician's own key, not minted by the agent. |
| AIUC-1, action authorization | Was each action checked against an authorized policy before it ran? | Per receipt `in_policy`, `policy_reason`, `policy_hash`, `plan_signature`; plan `signature` | Confirm the plan's own `signature` verifies, then confirm every receipt's `policy_hash` is identical, which shows they were all judged against the same signed policy. Each receipt's `in_policy` and `policy_reason` record the decision that policy produced. |
| AIUC-1, audit trail | Can the full sequence of actions be reconstructed and shown to be complete? | `receipt_index.json` table; per receipt `seq`, `previous_receipt_hash`; the chain root in `receipt_index.json` | Read `receipt_index.json` for the ordered list and the counts of in-policy and out-of-policy receipts. Completeness is proven by the chain: the root fingerprint recomputed by `verify.mjs` matches the one in the index, so no receipt is missing from the run. |

The receipts in the sample packet also carry an `aiuc_controls` field listing the
AIUC-1 control identifiers each receipt is evidence for. That field is a label
the producer attaches, so treat it as a pointer to the control, and rely on the
signed fields above for the actual proof.

For the limits of what these fields prove, see the
[reviewer guide](../FOR-REVIEWERS.md#what-a-receipt-does-not-prove) and the
[threat model](../THREAT-MODEL.md).
