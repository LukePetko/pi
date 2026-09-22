import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { hubStateDir } from "./pi-hub-web-launcher.ts";

export interface LifecycleFields {
	lifecycleGeneration: string;
	lifecycleRevision: number;
	turnState: "running" | "returned" | "prompt";
	lastAgentEnd: number | null;
	lastAgentEndError: boolean;
	lastUserTurn: number | null;
	enteredStateAt: number;
	lastAssistantText: string;
}
export interface LifecycleIdentity {
	id: string;
	pid: number;
	startedAt: number;
	endpointEpoch?: string;
}
export const lifecycleDirectory = () => join(hubStateDir(), "lifecycle");

/** Low-level agent_end is provisional: only agent_settled rules out automatic continuation. */
export function createLifecycle(now = Date.now()) {
	let fields: LifecycleFields = {
		lifecycleGeneration: randomUUID(), lifecycleRevision: 0, turnState: "returned", lastAgentEnd: null, lastAgentEndError: false,
		lastUserTurn: null, enteredStateAt: now, lastAssistantText: "",
	};
	let running = false;
	let prompts = 0;
	let pending: Pick<LifecycleFields, "lastAgentEnd" | "lastAgentEndError" | "lastAssistantText"> | undefined;
	function transition(at: number, force = false) {
		fields = { ...fields, lifecycleRevision: fields.lifecycleRevision + 1 };
		const turnState = prompts ? "prompt" : running ? "running" : "returned";
		if (force || turnState !== fields.turnState) fields = { ...fields, turnState, enteredStateAt: at };
	}
	return {
		snapshot: (): LifecycleFields => ({ ...fields }),
		start(at = Date.now()) { running = true; pending = undefined; transition(at); },
		user(at = Date.now()) { fields = { ...fields, lastUserTurn: at, lifecycleRevision: fields.lifecycleRevision + 1 }; },
		end(messages: AgentEndEvent["messages"], at = Date.now()) {
			const assistant = messages.findLast((message) => message.role === "assistant");
			const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted";
			const text = assistant?.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
			pending = { lastAgentEnd: at, lastAgentEndError: failed,
				lastAssistantText: (failed && assistant?.errorMessage ? assistant.errorMessage : text).slice(0, 600) };
		},
		settled(at = Date.now()) {
			running = false;
			if (pending) fields = { ...fields, ...pending };
			pending = undefined;
			transition(at);
		},
		promptStart(at = Date.now()) { prompts++; transition(at); },
		promptEnd(at = Date.now()) { prompts = Math.max(0, prompts - 1); transition(at); },
		statusChanged(at = Date.now()) { if (!prompts) transition(at, true); },
	};
}

function cacheFile(directory: string, identity: LifecycleIdentity): string {
	if (!identity.endpointEpoch) throw new Error("Lifecycle requires a broker endpoint epoch");
	const key = JSON.stringify([identity.id, identity.pid, identity.startedAt, identity.endpointEpoch]);
	return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function writeLifecycle(directory: string, identity: LifecycleIdentity, fields: LifecycleFields): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = cacheFile(directory, identity);
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ version: 1, identity, fields }), { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally { await unlink(temporary).catch(() => {}); }
}

const timestamp = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
export async function readLifecycle(directory: string, identity: LifecycleIdentity): Promise<LifecycleFields | undefined> {
	try {
		const handle = await open(cacheFile(directory, identity), "r");
		let data;
		try {
			const buffer = Buffer.alloc(8193);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 8192) return undefined;
			data = JSON.parse(buffer.toString("utf8", 0, bytesRead));
		} finally { await handle.close(); }
		const owner = data?.identity;
		const f = data?.fields;
		if (data?.version !== 1 || owner?.id !== identity.id || owner?.pid !== identity.pid
			|| owner?.startedAt !== identity.startedAt || owner?.endpointEpoch !== identity.endpointEpoch
			|| !f || typeof f.lifecycleGeneration !== "string" || !/^[a-f0-9-]{36}$/.test(f.lifecycleGeneration)
			|| !Number.isSafeInteger(f.lifecycleRevision) || f.lifecycleRevision < 0
			|| !["running", "returned", "prompt"].includes(f.turnState)
			|| !(f.lastAgentEnd === null || timestamp(f.lastAgentEnd))
			|| !(f.lastUserTurn === null || timestamp(f.lastUserTurn)) || !timestamp(f.enteredStateAt)
			|| typeof f.lastAgentEndError !== "boolean" || typeof f.lastAssistantText !== "string"
			|| f.lastAssistantText.length > 600) return undefined;
		return { lifecycleGeneration: f.lifecycleGeneration, lifecycleRevision: f.lifecycleRevision, turnState: f.turnState, lastAgentEnd: f.lastAgentEnd, lastAgentEndError: f.lastAgentEndError,
			lastUserTurn: f.lastUserTurn, enteredStateAt: f.enteredStateAt, lastAssistantText: f.lastAssistantText };
	} catch { return undefined; }
}

export async function removeLifecycle(directory: string, identity: LifecycleIdentity): Promise<void> {
	await unlink(cacheFile(directory, identity)).catch(() => {});
}
