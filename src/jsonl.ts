import type { Event, JSONLEvent } from "./types.js";

export function eventToJSONL(event: Event, runId: string): JSONLEvent {
  return {
    timestamp: event.timestamp,
    runId,
    tool: event.tool,
    result: event.result,
    ...(event.reason !== undefined && { reason: event.reason }),
    ...(event.details !== undefined && { details: event.details }),
    ...(Object.keys(event.params).length > 0 && { params: event.params }),
    ...(event.cost !== undefined && { cost: event.cost }),
    ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
    ...(event.estimate !== undefined && { estimate: event.estimate }),
    ...(event.cumulative !== undefined && { cumulative: event.cumulative }),
    ...(event.callIndex !== undefined && { callIndex: event.callIndex }),
  };
}

export function formatJSONL(events: Event[], runId: string): string {
  return events.map((e) => JSON.stringify(eventToJSONL(e, runId))).join("\n");
}

export function parseJSONL(input: string): JSONLEvent[] {
  return input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as JSONLEvent);
}

export function emitJSONL(event: Event, runId: string, stream?: NodeJS.WritableStream): void {
  const line = JSON.stringify(eventToJSONL(event, runId)) + "\n";
  (stream ?? process.stdout).write(line);
}
