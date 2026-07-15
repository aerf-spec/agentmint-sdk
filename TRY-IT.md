# The half-day trial

For an engineer at an agent vendor with a security review coming. This takes
about half a day of clock time, most of it your agent running normally. It adds
no architecture risk. You end holding an evidence packet you can forward to a
buyer.

Each step has a time estimate. Steps 0, 1, 3, and 4 are about an hour together.
Step 2 is your agent running on its own.

## Step 0: see the deliverable first (5 minutes)

Verify a finished evidence packet before you touch your code, so you know what
you are working toward. You need Node 18 or newer. Nothing else.

If you cloned this repo, a sample is already here:

```
cd examples/sample-evidence-packet
unzip evidence.zip -d packet
node packet/verify.mjs
```

If you did not clone it, download `evidence.zip` from the Releases page and run
the same two commands. You should see every check pass and the line
`All checks passed`.

That is the exact experience your buyer gets. No account, no install, no network.

## Step 1: wrap your tools in shadow mode (15 minutes)

Add one line around your tools.

```ts
import { harden } from "@npmsai/agentmint";

const tools = harden(myTools, { mode: "shadow" });
```

**Shadow mode records everything and blocks nothing. Your agent's behavior does
not change. Removal is deleting that one line.**

Confirm the install works on your machine in ten seconds:

```
npx @npmsai/agentmint doctor
```

It checks your Node version, confirms your tool shape (raw, OpenAI, Anthropic,
LangChain, or Vercel) is wrapped correctly, and prints which mode is active. To
generate a matching observe-only spec, run `npx @npmsai/agentmint init --shadow`.

Want to see it run before wiring your own tools? `npm run example:trial` does the
whole trial with a toy prior auth agent.

## Step 2: run your agent normally for a day

Nothing to do here except let real traffic flow. Receipts accumulate as your
agent works.

What is captured: the tool name, a timestamp, the result, and the parameters you
choose to record. What is not captured: nothing you do not pass in, and by
default long strings and objects are redacted. See "What leaves your
environment" below.

## Step 3: export your own packet and verify it (15 minutes)

Turn on a signed plan so the receipts bind to what the agent was allowed to do,
then export. The trial example writes receipts to `out/` for you:

```
npm run example:trial
npx @npmsai/agentmint export \
  --from examples/trial-agent/out/receipts \
  --plan examples/trial-agent/out/plan.json \
  --key examples/trial-agent/out/notary_key.pem \
  --out evidence.zip
```

Now verify it yourself, exactly the way your buyer will:

```
unzip evidence.zip -d packet
node packet/verify.mjs
```

You should see `All checks passed`. That zip is your forwardable packet.

## Step 4: read it as your buyer would (10 minutes)

Open [FOR-REVIEWERS.md](FOR-REVIEWERS.md) and follow it as if you had received
the packet. It is one page, one command, pass or fail. Then open the
[compliance crosswalk](docs/compliance-crosswalk.md) to see which questionnaire
rows the packet answers, and which it does not.

## What leaves your environment

Nothing, by default. Receipts are generated and stored in your runtime. PHI
never reaches agentmint. There is no agentmint service in your data flow, so
trying this adds no new subprocessor and no new BAA to your compliance story.

Put identifiers, not clinical payloads, in evidence fields. Long strings and
objects are redacted by default. For exact control, name the only fields allowed
onto a receipt:

```ts
const tools = harden(myTools, { mode: "shadow", evidenceFields: ["patient_id", "auth_id"] });
```

Every parameter not on that list is replaced with `[REDACTED]` before it is
recorded, whatever its type.

## The decision

If the packet would help your next review, add a spec and signing. If not, delete
the wrapper line. Total cost: half a day.
