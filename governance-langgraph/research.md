# LangGraph Governance Research

Inspected versions:

- `@langchain/langgraph@1.4.7`
- `@langchain/core@1.2.1`

Primary docs:

- https://docs.langchain.com/oss/javascript/langgraph/overview
- https://docs.langchain.com/oss/javascript/langgraph/interrupts
- https://reference.langchain.com/javascript/langchain-langgraph

Primary source reviewed locally:

- `node_modules/@langchain/langgraph/dist/prebuilt/tool_node.js`
- `node_modules/@langchain/langgraph/dist/graph/state.js`
- `node_modules/@langchain/langgraph/dist/pregel/index.js`
- `node_modules/@langchain/langgraph/dist/pregel/types.d.ts`
- `node_modules/@langchain/core/dist/tools/index.js`

## 1. Does LangGraph validate tool input schemas before calling the tool function?

Answer: `Partially yes, but by delegation, not by a LangGraph-specific governance layer.`

Evidence:

- `ToolNode` calls `tool.invoke(toolCall, runtime)` before any custom tool logic:

```js
const output = await tool.invoke(toolCall, runtime);
```

- `StructuredTool.call()` in `@langchain/core` parses input before `_call(...)`:

```js
parsed = await interopParseAsync(this.schema, inputForValidation);
const raw = await this._call(parsed, runManager, config);
```

Interpretation:

- In standard LangGraph + LangChain tool usage, schema-invalid inputs are rejected before the tool function runs.
- This is not a LangGraph-only policy feature. LangGraph delegates to the tool implementation.
- It is also not universal for every possible `RunnableToolLike`; the strong guarantee exists for schema-backed LangChain tools.

## 2. Does LangGraph validate tool output schemas after the tool returns?

Answer: `No, not as a built-in tool-output schema validator.`

Evidence:

- `ToolNode` wraps the tool result into a `ToolMessage`, but does not validate it against an output schema:

```js
return new ToolMessage({
  status: "success",
  name: tool.name,
  content: typeof output === "string" ? output : JSON.stringify(output),
```

- `StructuredTool.call()` formats output and calls `handleToolEnd`, but there is no output-schema parse step before returning:

```js
const formattedOutput = _formatToolOutput({ ... });
await runManager?.handleToolEnd(formattedOutput);
return formattedOutput;
```

Interpretation:

- LangGraph can validate graph state schemas, but that is different from validating a tool's returned payload against a declared tool output schema.

## 3. Can you define "tool A must run before tool B" as a graph constraint?

Answer: `Yes at the graph topology level, but not as a built-in declarative tool policy inside ToolNode.`

Evidence:

- `StateGraph` exposes graph edges and conditional edges, and compile-time validation uses those node relationships.
- In source, compiled graphs attach explicit edges:

```js
for (const [start, end] of this.edges) compiled.attachEdge(start, end);
```

Interpretation:

- If you model tool A and tool B as separate nodes, you can force order with graph edges.
- If both are merely tool names inside one `ToolNode`, LangGraph does not provide a native rule like `requires: [tool_a]`.

## 4. Does checkpointing produce a structured, queryable record of every tool call with args and results?

Answer: `Partially. Checkpoints are structured and queryable, but they are not a first-class tool-call audit ledger.`

Evidence:

- Checkpoints are exposed via `getState()` and `getStateHistory()`:

```ts
getState(config: RunnableConfig, options?: GetStateOptions): Promise<StateSnapshot>;
getStateHistory(config: RunnableConfig, options?: CheckpointListOptions): AsyncIterableIterator<StateSnapshot>;
```

- `StateSnapshot` includes `values`, `createdAt`, `metadata`, and `tasks`:

```ts
readonly values: Record<string, any> | any;
readonly createdAt?: string;
readonly tasks: PregelTaskDescription[];
```

- In a real probe run, checkpoint state contained:
  - tool args in `AIMessage.tool_calls[].args`
  - tool results in `ToolMessage.content`
  - task outputs in `tasks[].result`

Interpretation:

- You can query checkpoints and reconstruct tool activity if your state stores messages.
- But LangGraph does not write a dedicated normalized record like `{tool,args,result,policy,timestamp}` for every call.

## 5. Does LangGraph detect identical consecutive tool calls (loop detection)?

Answer: `No.`

Evidence:

- The closest built-in control is a global recursion/superstep cap:

```js
if (loop.status === "out_of_steps") throw new GraphRecursionError([
  `Recursion limit of ${config.recursionLimit} reached`,
```

Interpretation:

- This limits total graph steps.
- It does not compare consecutive tool names or identical argument payloads.

## 6. Does LangGraph enforce rate limits on tool calls per time window?

Answer: `No built-in per-window tool-call rate limiter was found.`

Evidence:

- Source searches over `@langchain/langgraph` found retry, timeout, checkpoint, and recursion controls, but no tool-call window/rate-limit mechanism.
- The closest unrelated hit was retry logic recognizing provider quota errors, not enforcing a user-defined rate policy.

Interpretation:

- Any rate limiting would need to be implemented in custom node/tool code or an external wrapper.

## 7. Does `interrupt_before` / `interrupt_after` serve as policy enforcement for specific tools?

Answer: `Only at the node level, not as a native per-tool policy inside ToolNode.`

Evidence:

- The public API accepts node names:

```ts
interruptBefore?: All | Array<keyof Nodes>;
interruptAfter?: All | Array<keyof Nodes>;
```

- The docs in `pregel/types.d.ts` describe them as:

```ts
List of nodes where execution should be interrupted BEFORE the node runs.
```

- The same docs explicitly say for human-in-the-loop workflows developers should prefer the `interrupt` function.

Interpretation:

- If a whole tool execution stage is one node named `"tools"`, you can interrupt before or after that node.
- You cannot say "interrupt only when `delete_order` is requested" unless you model that tool as its own node or add custom routing logic.

## 8. Can a LangGraph state reducer reject a tool call based on business logic?

Answer: `Not as a pre-call governance hook.`

Evidence:

- State/update validation happens when node outputs are being written back into graph state:

```js
const validateStateUpdates = async (updates) => { ... }
```

- The validated object is a state update returned by a node, not an intercepted tool invocation.

Interpretation:

- A reducer or schema can reject an invalid state update after a node returns.
- It is not a built-in mechanism to veto a tool call before execution based on business logic.

## 9. Does LangGraph log tool call decisions in a format suitable for compliance audit (timestamps, caller, args, result, policy applied)?

Answer: `No built-in compliance-grade tool-policy audit format was found.`

Evidence:

- `streamMode: "tools"` exists and emits structured lifecycle events:

```ts
"tools": Streams tool-call lifecycle events (on_tool_start, on_tool_event, on_tool_end, on_tool_error)
```

- The tool stream payload only includes:

```ts
{ event, toolCallId?, name, input }
{ event, toolCallId?, name, output }
{ event, toolCallId?, name, error }
```

- `StateSnapshot` has `createdAt`, but the tool stream type itself does not include timestamps or policy metadata.

Interpretation:

- LangGraph provides useful observability primitives.
- It does not natively log policy decisions because it does not natively apply tool-governance policies like deny lists, cross-tool checks, or budget blocks.

## 10. Does LangGraph have built-in cost tracking or budget ceilings for tool calls?

Answer: `No built-in tool cost tracker or tool budget ceiling was found.`

Evidence:

- The inspected runtime exposes retries, timeouts, interrupts, checkpointing, and streaming.
- No built-in tool-cost accumulator or budget enforcement API was present in the inspected LangGraph sources.

Interpretation:

- You would need custom logic or an external wrapper to meter tool costs and stop at a threshold.

## 11. Can LangGraph prevent a tool from being called at all (deny list)?

Answer: `Only indirectly by not exposing the tool or by not routing to its node; no built-in runtime deny-list policy was found.`

Evidence:

- `ToolNode` resolves a tool by name and errors if it is absent:

```js
const tool = this.tools.find((tool) => tool.name === call.name);
if (tool === void 0) throw new Error(`Tool "${call.name}" not found.`);
```

Interpretation:

- If you never register a tool, LangGraph cannot call it.
- That is different from a policy layer where a tool exists but is dynamically denied based on rules.

## 12. Does LangGraph validate cross-tool data consistency (output of tool A used as input to tool B)?

Answer: `No built-in cross-tool consistency validator was found.`

Evidence:

- Tool input validation is per-tool schema validation.
- Graph state validation validates state shape/update shape.
- No inspected LangGraph source compared tool B input to tool A output semantically.

Interpretation:

- You can implement this yourself with custom nodes, custom state logic, or an external wrapper.
- It is not a built-in LangGraph governance feature.

## Bottom Line

What LangGraph already gives you:

- Strong orchestration primitives
- Graph topology constraints
- Checkpointing and state history
- Human-in-the-loop interrupts
- Schema validation for standard LangChain tools

What it does not natively provide:

- Cross-tool business-rule enforcement
- Deny-list policy
- Consecutive-call loop detection
- Velocity/rate-limit breakers
- Tool cost budgets
- First-class compliance audit records with policy outcomes
