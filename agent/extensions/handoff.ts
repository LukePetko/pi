import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	IntercomExtensionChannel, IntercomExtensionRegistration,
} from "../npm/node_modules/pi-intercom/extension-api.ts";
// Public event-bus names; type-only package imports keep this producer loadable by Node too.
const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";
import {
	createLifecycle, lifecycleDirectory, removeLifecycle, writeLifecycle,
	type LifecycleIdentity,
} from "./lib/hub-lifecycle.ts";

/** Phase 2 lifecycle only. No handoff tool, prompt injection, reply or approval policy. */
export default function handoff(pi: ExtensionAPI) {
	let context: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let channel: IntercomExtensionChannel | undefined;
	let identity: LifecycleIdentity | undefined;
	let disposed = false;
	let registered = false;
	let binding = 0;
	let writes = Promise.resolve();
	let state = createLifecycle();
	const directory = lifecycleDirectory();
	const files = new Map<string, LifecycleIdentity>();
	const tools = new Map<string, string>();
	const live = () => !disposed && context?.sessionManager.getSessionId() === sessionId;
	function publish() {
		if (!identity || !live()) return;
		const owner = identity;
		const fields = state.snapshot();
		writes = writes.then(async () => {
			if (!live() || identity !== owner) return;
			await writeLifecycle(directory, owner, fields);
			files.set(owner.endpointEpoch!, owner);
		}).catch((error) => { console.error("Hub lifecycle publication failed:", error.message); });
		return writes;
	}
	async function bind() {
		const generation = ++binding;
		if (!live() || !channel?.snapshot().connected) return;
		try {
			// The roster supplies a broker-owned registration epoch, including on reconnect.
			const sessions = await channel.listSessions();
			if (!live() || generation !== binding || !channel.snapshot().connected) return;
			const id = process.env.PI_INTERCOM_SESSION_ID;
			const own = sessions.find((s) => s.id === id && s.pid === process.pid);
			if (!own?.endpointEpoch) return; // Older brokers cannot safely bind a private record.
			identity = { id: own.id, pid: own.pid, startedAt: own.startedAt, endpointEpoch: own.endpointEpoch };
			await publish();
		} catch { /* A subsequent connection/roster event retries, never guess an identity. */ }
	}
	const registration: IntercomExtensionRegistration = {
		namespace: "pi-hub-lifecycle", ownerEligible: false,
		onReady(value) { channel = value; return bind(); },
		onEvent(event) {
			if (event.type === "connection") {
				binding++;
				identity = undefined;
				if (event.connected) return bind();
			} else if (event.type === "session_joined" && event.session.pid === process.pid) {
				return bind();
			}
		},
	};
	function register() {
		if (registered || disposed) return;
		pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, registration);
		// The event bus does not report listener presence; onReady is the acknowledgement.
		registered = channel !== undefined;
	}
	const unsubscribe = pi.events.on(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, register);
	register();
	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		state = createLifecycle();
		register();
		return bind();
	});
	pi.on("message_start", (event) => {
		if (live() && event.message.role === "user") { state.user(); return publish(); }
	});
	pi.on("agent_start", () => { if (live()) { tools.clear(); state.start(); return publish(); } });
	pi.on("agent_end", (event) => { if (live()) state.end(event.messages); });
	pi.on("agent_settled", () => { if (live()) { tools.clear(); state.settled(); return publish(); } });
	pi.on("ui_prompt_start", () => { if (live()) { state.promptStart(); return publish(); } });
	pi.on("ui_prompt_end", () => { if (live()) { state.promptEnd(); return publish(); } });
	pi.on("tool_execution_start", (event) => {
		if (!live()) return;
		const before = tools.values().next().value;
		tools.set(event.toolCallId, event.toolName);
		if (before !== tools.values().next().value) { state.statusChanged(); publish(); }
	});
	pi.on("tool_execution_end", (event) => {
		if (!live()) return;
		const before = tools.values().next().value;
		tools.delete(event.toolCallId);
		if (before !== tools.values().next().value) { state.statusChanged(); publish(); }
	});
	pi.on("session_shutdown", async () => {
		disposed = true;
		binding++;
		unsubscribe();
		identity = undefined;
		await writes;
		await Promise.all([...files.values()].map((owner) => removeLifecycle(directory, owner)));
		context = undefined;
		tools.clear();
	});
}
