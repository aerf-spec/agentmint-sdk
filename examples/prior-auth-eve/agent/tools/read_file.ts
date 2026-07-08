// Default-harness tool disabled: a prior-auth compliance agent exposes only its
// six authored tools — no shell, filesystem, web, todo, questions, or subagents.
import { disableTool } from "eve/tools";
export default disableTool();
