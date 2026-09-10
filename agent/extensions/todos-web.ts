import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isTaskDetails, replayFromBranch } from "../npm/node_modules/@juicesharp/rpiv-todo/state/replay.ts";
import { loadConfig as loadIntercomConfig } from "../npm/node_modules/pi-intercom/config.ts";
import { removeHubTodos, writeHubTodos } from "./lib/hub-todos.ts";
import { hubStateDir } from "./lib/pi-hub-web-launcher.ts";

/** A read-only publisher of todo snapshots; never registers another todo tool. */
export default function todosWeb(
	pi: ExtensionAPI,
	options: { directory?: string; stableId?: string } = {},
): void {
	const directory = options.directory ?? join(hubStateDir(), "todos");
	// Match Intercom's registration identity, including configured stable aliases.
	const stableId = options.stableId ?? (process.env.PI_INTERCOM_STABLE_ID?.trim() || loadIntercomConfig().stableId);
	let pending = Promise.resolve();
	let warned = false;

	function enqueue(ctx: ExtensionContext, tasks?: unknown): Promise<void> {
		const identity = { id: stableId || ctx.sessionManager.getSessionId(), pid: process.pid };
		pending = pending.then(() => tasks === undefined
			? removeHubTodos(directory, identity)
			: writeHubTodos(directory, identity, tasks)).catch(() => {
			if (warned) return;
			warned = true;
			try {
				if (ctx.hasUI) ctx.ui.notify("Could not update Hub web todos; terminal todos are unaffected.", "warning");
			} catch { /* A queued write may finish after this UI context is disposed. */ }
		});
		return pending;
	}

	const replay = (_event: unknown, ctx: ExtensionContext) => enqueue(ctx, replayFromBranch(ctx).tasks);
	pi.on("session_start", replay);
	pi.on("session_tree", replay);
	pi.on("session_compact", replay);
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "todo" && !event.isError && isTaskDetails(event.result.details)) {
			return enqueue(ctx, event.result.details.tasks);
		}
	});
	pi.on("session_shutdown", (_event, ctx) => enqueue(ctx));
}
