# You received an evidence packet

Someone sent you `evidence.zip` and asked you to confirm what their AI agent
did. This page is everything you need. You do not have to be a developer, and
you do not have to trust the vendor. You check their claims yourself.

You do not need to install their software, create an account, or connect to the
internet. You need Node 18 or newer, which you may already have.

## What is in the packet

Unzip it and you will find:

- **Receipts.** One signed record per action the agent took.
- **The signed plan.** The statement of what the agent was allowed to do.
- **The public key.** The single value that lets you check every signature.
- **A standalone verifier**, `verify.mjs`. It uses only Node. It does not call anyone.

## The one command

Open a terminal in the folder where you saved the file.

```
unzip evidence.zip -d packet
node packet/verify.mjs
```

That is the whole check. It either passes or it fails, and it tells you which.

## What a pass looks like

```
  ok    plan signature
  ok    signature  a1000001  read:patient_record:PT-4821
  ok    signature  a2000002  submit:prior_auth:PA-2210
  ok    signature  a3000003  read:patient_record:PT-4498
  ok    signature  a4000004  submit:appeal:APL-1103
  ok    signature  a5000005  submit:appeal:APL-1103
  ok    signature  a6000006  submit:appeal:APL-1103
  ok    chain root 2093f65124f37dc4…

All checks passed: 6 receipt(s), chain intact.
```

Line by line:

- `plan signature` confirms the plan was signed by the key and not edited afterward.
- Each `signature` line confirms that one receipt was signed by the same key and no field in it changed after signing.
- The short code, like `a3000003`, names the receipt. The text after it is the action it recorded.
- `chain root` confirms the receipts are in one unbroken sequence, with none removed.
- The final line is the verdict. A pass means every check above held.

The command also exits with code 0 on a pass, so you can wire it into your own review tooling.

## What a fail looks like

If anyone changes a receipt after the fact, the check fails and points at the
exact receipt. Here is a real failure, after one receipt's action field was
edited from `read:patient_record:PT-4498` to a different record:

```
  ok    plan signature
  ok    signature  a1000001  read:patient_record:PT-4821
  ok    signature  a2000002  submit:prior_auth:PA-2210
  FAIL  signature INVALID for a3000003-0000-4000-8000-000000000003
  ok    signature  a4000004  submit:appeal:APL-1103
  FAIL  chain link broken at a4000004-0000-4000-8000-000000000004 (a receipt was removed or reordered)
  ok    signature  a5000005  submit:appeal:APL-1103
  ok    signature  a6000006  submit:appeal:APL-1103

2 check(s) FAILED
```

The edited receipt, `a3000003`, fails its signature check. The receipt right
after it also fails, because each receipt is linked to the one before, so a
change ripples forward. The command exits with code 1. You do not have to find
the tampering. The check finds it and names it.

## What a pass proves

- Each receipt was signed by the holder of the key, and no signed field changed after signing.
- The receipts are complete and in order. If one had been removed, the chain would break at a named point.
- The actions on the receipts are the actions the agent took under a plan that was itself signed.

## What a receipt does not prove

Be precise about the limits. Sourced from the project's
[THREAT-MODEL.md](THREAT-MODEL.md).

- It does not prove the plan was the right plan. A faithful receipt under a weak policy is still a faithful record of a weak decision.
- It does not prove the agent was not manipulated. If the agent was tricked into an in-scope action, the receipt honestly records an in-scope action.
- It does not prove the tool did what it reported. The receipt records the call and the reported result, not the real-world effect.
- It does not, by itself, prove this is the latest packet. To rule out an old but valid packet being resent, compare its chain root against one the vendor published earlier.

What a receipt makes impossible is silent revision. The record cannot be changed
after the fact without this check catching it and naming what changed.

## Requirements

- Node 18 or newer.
- Nothing else. No agentmint install. No account. No network.

## Mapping this to your controls

To connect the receipt fields to specific control questions, HIPAA, the
clinician determination requirement, and audit trail controls, see
[docs/compliance-crosswalk.md](docs/compliance-crosswalk.md).
