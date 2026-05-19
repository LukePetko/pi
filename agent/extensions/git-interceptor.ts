import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const GIT_ENV_PREFIX =
	"export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n";

const NO_VERIFY_RE = /--no-verify\b/;
const BLOCK_REASON =
	"BLOCKED: --no-verify is not allowed. Git hooks exist for a reason. " +
	"Fix the hook failure or ask the user for help instead.";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (!isToolCallEventType("bash", event)) return;
		if (!event.input.command.includes("git")) return;

		if (NO_VERIFY_RE.test(event.input.command)) {
			return { block: true, reason: BLOCK_REASON };
		}

		event.input.command = GIT_ENV_PREFIX + event.input.command;
	});
}
