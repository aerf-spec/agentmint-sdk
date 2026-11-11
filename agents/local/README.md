# Local test agent (bring your own agent)

A health-insurance member-line agent that runs on your machine and your model, and reports to the
platform through the ingest API (`docs/BYO-AGENT.md`). The prompt and the raw thinking stay here.
The platform gets a hash of the prompt, a salted commitment `sha256(salt + ":" + thinking)` per
model call, tool-call hashes, and each decision with its cited claims.

```bash
npm start                                         # the platform, in another terminal
npx tsx agents/local/run.ts                       # all scenarios with the scripted mock model
npx tsx agents/local/run.ts 01-visits-left --model mock-rc
npx tsx agents/local/run.ts --say VERIFY --say "Is Bayview covered?"
```

Flags: `--model` (default `mock`), `--base-url` (default `http://localhost:1234/v1`), `--api-key`,
`--platform` (default `http://localhost:4173`), `--key` (default `test`), `--max-iter`.
Env: `LOCAL_MODEL`, `LOCAL_BASE_URL`, `LOCAL_API_KEY`, `PLATFORM_URL`, `INGEST_API_KEY`.

`mock` puts its reasoning in `<think>` tags and `mock-rc` puts it in `reasoning_content`. Neither needs a model server.

Output goes to `harness/runs/<time>-local-<model>/<scenario>/`:
`report.html` / `report.md` (checks, the call, each decision), `package.json` (the evidence package),
`sent.jsonl` (every request body sent to the platform) and `private.jsonl` (the thinking and the salts).
`private.jsonl` and the reports contain the raw thinking. They are the vendor's copy, so don't share them.

The report checks: expected and forbidden decisions, no PHI before the date of birth is verified, all
citations resolved, every record accepted, signed and anchored, our own verifier and the chain both pass,
every reasoning commitment opens with our salt, and **IP protection**. That last check scans every request
body for any 6-word run of the prompt, any 12-word run of a thinking block, any salt, and any `prompt` /
`system` / `thinking` / `reasoning_text` field. The agent also blocks such a body before sending it, and it
replaces a decision claim that copies the prompt or the thinking with `(withheld by leak scan)`.

## LM Studio

1. Download a model that shows the tool-use (hammer) badge, e.g. Qwen3 8B, and load it.
2. Developer tab → Start Server (port 1234). In its settings, turn on separating `reasoning_content`
   from `content` if you want that path; leave it off to test `<think>` extraction.
3. `npx tsx agents/local/run.ts --model qwen/qwen3-8b` (use the model id LM Studio shows).

## Ollama

```bash
ollama pull qwen3:8b
npx tsx agents/local/run.ts --base-url http://localhost:11434/v1 --model qwen3:8b
```

Ollama returns reasoning as `reasoning` or inline `<think>`, depending on version. Both are handled.

## vLLM

```bash
vllm serve Qwen/Qwen3-8B --enable-auto-tool-choice --tool-call-parser hermes --reasoning-parser qwen3
npx tsx agents/local/run.ts --base-url http://localhost:8000/v1 --model Qwen/Qwen3-8B
```

## Models to try

The agent needs tool calling to look things up and to call `record_decision`. A model without it will
just talk, which makes the expect checks fail, but the reasoning extraction and IP checks still apply.
"Tools" below means the model's chat template supports function calling. Check the model card for your build.

| Model | Tools | Reasoning shows up as |
|---|---|---|
| Qwen3 4B / 8B / 14B / 30B-A3B | yes | `<think>` or `reasoning_content` |
| gpt-oss-20b | yes | `reasoning_content` / `reasoning` |
| DeepSeek-R1-0528-Qwen3-8B (distill) | partial | `<think>` |
| Llama 3.1 8B / 3.3 70B Instruct | yes | none |
| Mistral Small 3.2, Granite 3.3 / 4 | yes | none (Granite: optional thinking) |
| **Healthcare:** MedGemma 4B / 27B | no (Gemma 3 template) | none, or `<think>` if prompted |
| II-Medical-8B (Qwen3-based) | via Qwen3 template, untested | `<think>` |
| Baichuan-M2-32B | unclear | `<think>` |
| OpenBioLLM 8B / 70B, HuatuoGPT-o1 | no | none / `<think>` (Huatuo) |

To compare reasoning extraction, run the same scenarios on several models and look at "reasoning via …"
in each report footer and in the run's `README.md`.
