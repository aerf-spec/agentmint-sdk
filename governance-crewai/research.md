# CrewAI Governance Analysis

Research snapshot:
- Date reviewed: 2026-06-30
- Docs source reviewed: `crewai-src/docs/v1.15.1/en`
- Code source reviewed: `crewai-src/lib/crewai/src/crewai`
- Basis: local clone of `crewAIInc/crewAI` `main`, plus the versioned docs bundled in that repo

Method:
- I treated CrewAI docs as the product claim.
- I treated source as the implementation truth.
- Where docs and source diverged, I called that out explicitly.

## Findings

### 1. Does CrewAI validate tool inputs before calling the tool function?

Verdict: Yes.

Evidence:
- `ToolUsage._validate_tool_input()` parses tool input into a dictionary and emits `ToolValidateInputErrorEvent` on failure: `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:884-948`.
- `CrewStructuredTool._parse_args()` validates parsed arguments against `args_schema` with `model_validate(...)` before the tool function is executed: `crewai-src/lib/crewai/src/crewai/tools/structured_tool.py:272-295`.
- Tool hooks docs also describe parameter validation as a normal pre-execution pattern: `crewai-src/docs/v1.15.1/en/learn/tool-hooks.mdx:19-24`.

Nuance:
- In `ToolUsage._use()` and `_ause()`, CrewAI first filters arguments down to keys present in the schema before invoking the tool: `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:330-347`, `570-587`.
- That means unexpected extra keys are often dropped rather than treated as a hard failure.

### 2. Does CrewAI validate outputs from one agent before passing to another?

Verdict: Not by default.

Evidence:
- Docs say task guardrails validate task outputs before they are passed to the next task: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:301-303`.
- But Crew context handoff is built from aggregated `raw` task output strings, not from validated typed payloads: `crewai-src/lib/crewai/src/crewai/crew.py:1823-1830`, `crewai-src/lib/crewai/src/crewai/utilities/formatter.py:16-45`.
- Docs also say `TaskOutput` only includes `pydantic` or `json_dict` if configured, and otherwise defaults to raw output: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:164-170`.

Interpretation:
- CrewAI can validate a task output if you add a guardrail.
- CrewAI does not automatically validate every agent-to-agent handoff before use.
- The default handoff path is raw text context.

### 3. Does CrewAI detect delegation loops (agent A delegates to B, B back to A)?

Verdict: I did not find an explicit delegation-loop detector.

Evidence:
- Delegations are counted and coworker names are tracked, but I found no cycle-detection logic: `crewai-src/lib/crewai/src/crewai/task.py:141-143`, `245`, `1067-1071`; `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:317-327`, `557-567`.
- Docs frame loop avoidance as a design pattern, not an automatic protection. The collaboration guide recommends a clear hierarchy and disabling re-delegation on specialists: `crewai-src/docs/v1.15.1/en/concepts/collaboration.mdx:296-303`.

Interpretation:
- CrewAI tracks delegation activity.
- I did not find code that detects or blocks A -> B -> A cycles specifically.
- `max_iter` may eventually stop an agent loop, but that is not the same as delegation-cycle detection.

### 4. Does CrewAI's `output_pydantic` or `output_json` enforce output schemas?

Verdict: Partially, but not as a hard guarantee in every path.

Evidence:
- Docs present `output_json` and `output_pydantic` as structured output features: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:62-63`, `736-746`.
- Source validates task results through `convert_to_model()` and `validate_model()`: `crewai-src/lib/crewai/src/crewai/task.py:1116-1151`; `crewai-src/lib/crewai/src/crewai/utilities/converter.py:190-277`.
- On parse/validation failures, CrewAI falls back to partial-JSON handling and then to an LLM-based converter: `crewai-src/lib/crewai/src/crewai/utilities/converter.py:280-389`, `444-520`.
- If conversion still fails, the converter can return the original string result: `crewai-src/lib/crewai/src/crewai/utilities/converter.py:381-389`.
- `_unpack_model_output()` then leaves structured fields empty when the final value is not valid JSON/model output: `crewai-src/lib/crewai/src/crewai/task.py:1153-1166`.

Interpretation:
- CrewAI strongly attempts to coerce outputs into the requested schema.
- It is not a strict fail-closed schema gate in every case.
- If conversion cannot be completed, raw output can survive without a populated `pydantic` or `json_dict` field.

### 5. Does CrewAI log every tool call with timestamps and args in a structured format?

Verdict: It has structured tool-call events with timestamps and args, but not an always-on local audit log by default.

Evidence:
- Tool usage event types include `tool_name`, `tool_args`, and start/finish variants: `crewai-src/lib/crewai/src/crewai/events/types/tool_usage_events.py:10-90`.
- All events inherit a `timestamp` from `BaseEvent`: `crewai-src/lib/crewai/src/crewai/events/base_events.py:66-89`.
- Tool execution emits `ToolUsageStartedEvent` and `ToolUsageFinishedEvent`: `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:257-275`, `453-461`, `496-514`, `693-701`.
- Docs list these structured events explicitly: `crewai-src/docs/v1.15.1/en/concepts/event-listener.mdx:220-227`.
- Docs say tracing shows tool usage and LLM calls in AMP when tracing is enabled: `crewai-src/docs/v1.15.1/en/observability/tracing.mdx:10-13`, `181-190`.

Nuance:
- Executed tool calls are evented in a structured way.
- Persisting and viewing them depends on listeners/tracing.
- A tool blocked by a `before_tool_call` hook is stopped before normal tool execution, so it does not go through the same started/finished execution path.

### 6. Does CrewAI have task-level guards or callbacks that can reject a tool call?

Verdict: Not via the `Task` fields themselves, but yes via tool hooks.

Evidence:
- Task `guardrail`, `guardrails`, and `callback` are task-output/post-execution features: `crewai-src/lib/crewai/src/crewai/task.py:154-156`, `246-275`, `724-738`, `849-863`.
- Docs describe task guardrails as validating task output before the next task: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:301-303`, `451`.
- Tool hooks docs explicitly say `before_tool_call` hooks can block execution by returning `False`: `crewai-src/docs/v1.15.1/en/learn/tool-hooks.mdx:11-13`, `19-31`, `181-204`.
- Source enforces that block in `execute_tool_and_check_finality(...)`: `crewai-src/lib/crewai/src/crewai/utilities/tool_utils.py:95-117`, `215-237`.

Interpretation:
- `Task.guardrail` does not reject a tool call before the tool runs.
- `before_tool_call` hooks do provide a real pre-tool rejection point, and they receive task context.

### 7. Does CrewAI track token cost per task or per agent?

Verdict: It tracks usage metrics per agent execution and aggregated crew/flow usage, but I did not find a first-class per-task cost object on `TaskOutput`.

Evidence:
- Crew docs expose `crew.usage_metrics`: `crewai-src/docs/v1.15.1/en/concepts/crews.mdx:321-329`.
- Source aggregates usage metrics across agents and manager agent in `Crew.calculate_usage_metrics()`: `crewai-src/lib/crewai/src/crewai/crew.py:2074-2098`.
- Flows docs expose `flow.usage_metrics`: `crewai-src/docs/v1.15.1/en/concepts/flows.mdx:231-270`.
- Lite agent docs say `usage_metrics` are returned for an execution: `crewai-src/docs/v1.15.1/en/concepts/agents.mdx:581-587`.
- Agent/lite-agent code attaches usage metrics to agent output objects: `crewai-src/lib/crewai/src/crewai/agent/core.py:1731-1749`; `crewai-src/lib/crewai/src/crewai/lite_agent.py:679-692`.

Interpretation:
- Yes for agent-level execution output and crew/flow-level rollups.
- No clear per-task token ledger surfaced on `TaskOutput`.

### 8. Does `max_iter` on agents serve as a loop breaker?

Verdict: Yes, in the generic sense of limiting the agent loop.

Evidence:
- Agent model default is `max_iter=25` in source: `crewai-src/lib/crewai/src/crewai/agents/agent_builder/base_agent.py:286-288`.
- Executor also defaults to `max_iter=25`: `crewai-src/lib/crewai/src/crewai/agents/agent_builder/base_agent_executor.py:26-28`.
- The executor checks `has_reached_max_iterations(...)` inside the main ReAct/native loops and stops when the limit is reached: `crewai-src/lib/crewai/src/crewai/agents/crew_agent_executor.py:341-352`.
- Docs describe `max_iter` as the maximum iterations before the agent must provide its best answer: `crewai-src/docs/v1.15.1/en/concepts/agents.mdx:49`, `288`.

Important mismatch:
- The docs page says default `20`: `crewai-src/docs/v1.15.1/en/concepts/agents.mdx:49`.
- The source I reviewed defaults to `25`.

Interpretation:
- It is a real loop bound.
- It is not a specialized delegation-loop detector; it is a generic iteration cap.

### 9. Does the `human_input` flag serve as a checkpoint for high-stakes tools?

Verdict: Not for tool calls specifically.

Evidence:
- Docs say `human_input` prompts the user before the agent delivers its final answer: `crewai-src/docs/v1.15.1/en/learn/human-input-on-execution.mdx:13-17`.
- `Task.human_input` is passed into the executor as `ask_for_human_input`: `crewai-src/lib/crewai/src/crewai/task.py:227-230`; `crewai-src/lib/crewai/src/crewai/agent/core.py:859-865`, `981-987`.
- The executor only applies it after the agent loop has produced a final answer: `crewai-src/lib/crewai/src/crewai/agents/crew_agent_executor.py:243-245`.
- Tool-hook docs show the correct pre-tool approval mechanism for dangerous actions: `crewai-src/docs/v1.15.1/en/learn/tool-hooks.mdx:181-204`.

Interpretation:
- `human_input` is a final-answer review gate.
- It is not a built-in checkpoint in front of tool execution.

### 10. Can you deny specific tools from being called via CrewAI config?

Verdict: Indirectly yes through allowlisting, but I did not find a dedicated denylist setting in core CrewAI config.

Evidence:
- Tasks can restrict execution to a specific tool list: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:54`; `crewai-src/lib/crewai/src/crewai/task.py:210-213`.
- Agents also accept a tool list: `crewai-src/docs/v1.15.1/en/concepts/agents.mdx:47`; `crewai-src/lib/crewai/src/crewai/agents/agent_builder/base_agent.py:283-285`.
- Tool dispatch selects from the available tool set only: `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:759-802`.

Interpretation:
- You can effectively deny a tool by not including it in the task/agent tool list.
- I did not find a declarative `deny_tools=["x"]` style core setting.

### 11. Does CrewAI validate that data from task A is used correctly in task B?

Verdict: No built-in semantic validation found.

Evidence:
- Context passed to the next task is aggregated from raw outputs: `crewai-src/lib/crewai/src/crewai/crew.py:1823-1830`; `crewai-src/lib/crewai/src/crewai/utilities/formatter.py:16-45`.
- Docs recommend structured outputs and guardrails, but do not describe automatic validation of downstream usage semantics: `crewai-src/docs/v1.15.1/en/concepts/tasks.mdx:164-170`, `301-303`; `crewai-src/docs/v1.15.1/en/concepts/production-architecture.mdx:102-111`.

Interpretation:
- CrewAI can help shape or validate task A's output.
- I found no mechanism that checks whether task B used task A's data correctly.

### 12. Does CrewAI have rate limiting on tool calls?

Verdict: Not at the framework tool-call level.

Evidence:
- `max_rpm` is documented for agents and crews as request-per-minute control: `crewai-src/docs/v1.15.1/en/concepts/agents.mdx:50`, `152`, `290`; `crewai-src/docs/v1.15.1/en/concepts/crews.mdx:23`, `46`.
- Source RPM control is a generic request limiter used from the agent executor loop before LLM calls: `crewai-src/lib/crewai/src/crewai/utilities/rpm_controller.py:12-89`; `crewai-src/lib/crewai/src/crewai/utilities/agent_utils.py:389-398`; `crewai-src/lib/crewai/src/crewai/agents/crew_agent_executor.py:343-355`.
- Tool execution code does not have a framework-level rate limiter comparable to `max_rpm`: `crewai-src/lib/crewai/src/crewai/utilities/tool_utils.py:30-149`, `152-260`; `crewai-src/lib/crewai/src/crewai/tools/tool_usage.py:132-707`.

Nuance:
- Some individual tools or external providers document their own rate limits.
- I did not find a CrewAI-wide tool-call-per-window limiter in core.

## Bottom Line

CrewAI already has several meaningful governance building blocks:
- Tool input validation
- Structured tool-call events
- Task output guardrails with retries
- Structured output helpers
- Human review before final answers
- Iteration caps
- Usage metrics
- Tool allowlisting via task/agent tool lists

But CrewAI does not currently look equivalent to a declarative governance layer like the AgentMint spec in the prompt. Based on docs and source, I did not find built-in equivalents for:
- Declarative tool prerequisites like `send_email` requires `analyze_data`
- Cross-tool input lineage checks like `update_crm_record.id == create_crm_record.output.id`
- Explicit delegation-cycle detection
- Framework-level tool-call velocity limiting
- Automatic validation that task B used task A correctly
- A hard fail-closed guarantee that `output_pydantic` / `output_json` always produce schema-valid downstream objects
