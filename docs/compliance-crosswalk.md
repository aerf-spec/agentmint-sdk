# Compliance crosswalk

This maps common reviewer questions to the receipt fields that answer them and
how to check each one in an evidence packet. It cites control IDs so you can
line them up with your own framework. It is not legal advice, and it does not
claim the packet satisfies any control on its own. It shows where the evidence
for a control lives.

Every field named below is in a receipt inside the packet, or in
`receipt_index.json`. To follow along, unzip a packet and open those files. The
[sample packet](../examples/sample-evidence-packet/) is a good one to practice on.

| What the reviewer asks | Which receipt fields answer it | How to check it in the packet |
|---|---|---|
| HIPAA 164.312(a): was access limited to authorized records? | `action` (the record touched), `in_policy` (allowed or blocked), `policy_reason`, and `plan_id` naming the scope it ran under | Open the receipts. An out-of-scope read shows `in_policy: false` with a reason. The plan in `plan.json` shows the scope that bounded access. |
| HIPAA 164.312(b): is there a tamper-evident audit trail of activity? | `seq`, `previous_receipt_hash`, and `signature` on every receipt, plus `chain` in `receipt_index.json` | Run `node verify.mjs`. It confirms every signature, the links between receipts, and that none were removed. A pass is the audit trail intact. |
| Clinician determination (CMS-4201-F, California SB 1120): did a person, not an algorithm, decide? | The approval receipt: `action` for the appeal, `in_policy: true`, and `policy_reason` naming the approving clinician key | Find the appeal in the receipts. It appears first as held, then as an approved receipt whose reason names the clinician. The approval is its own signed record. |
| AIUC-1 action authorization: was each action authorized before it ran? | `plan_id`, `plan_signature`, and `policy_hash` binding each receipt to the signed plan | Verify the plan signature with `verify.mjs`, then confirm each receipt carries the same `plan_id`. Every action is bound to the authorization it ran under. |
| AIUC-1 audit trail: can the record be trusted after the fact? | The full signed, linked chain: `signature`, `previous_receipt_hash`, `seq`, and the `chain.root_hash` in the index | `node verify.mjs` recomputes the chain root and checks it against the index. If anything changed, the check fails and names the receipt. |

For what these receipts do not prove, see [THREAT-MODEL.md](../THREAT-MODEL.md).
For reviewers who received a packet, [FOR-REVIEWERS.md](../FOR-REVIEWERS.md) walks
the one command in plain language.
