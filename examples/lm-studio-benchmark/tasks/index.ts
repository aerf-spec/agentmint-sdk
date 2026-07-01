// Task registry. The shared Task type + SYSTEM live in ./base to avoid an import
// cycle (task files import base, index imports the task files).

import { task as codingAgent } from "./coding-agent.js";
import { task as scopeCreep } from "./scope-creep.js";
import { task as loopTrigger } from "./loop-trigger.js";

export { SYSTEM, type Task } from "./base.js";
export const ALL_TASKS = [codingAgent, scopeCreep, loopTrigger];
