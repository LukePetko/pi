import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { LifecycleFields } from "./hub-lifecycle.ts";
import type { SessionInfo } from "../../npm/node_modules/pi-intercom/types.ts";
import type { HubTodos } from "./hub-todos.ts";
import type { PermissionSummary, PermissionRisk } from "./hub-permissions.ts";

export type Bucket = "NEEDS_YOU" | "REVIEW" | "WORKING" | "PARKED";
export type Reason = "permission" | "prompt" | "question" | "error" | "done" | null;
export type AttentionPermission = PermissionSummary & { risk?: PermissionRisk; tool?: string; summary?: string };
export type AttentionInput = SessionInfo & Partial<LifecycleFields> & { todos?: HubTodos; permissions?: AttentionPermission[] };
export interface AttentionFields {
	bucket: Bucket;
	reason: Reason;
	displayName: string;
	waitingSince: number | null;
	enteredStateAt: number;
	lastAgentEnd: number | null;
	risk?: PermissionRisk;
}

// Intercom permits a configured suffix after its lifecycle status.
export const lifecycleStatus = (status?: string) => (status ?? "").split(" · ")[0];

/** Real producer signals are authoritative; approximate only for legacy producers. */
export function classify(session: AttentionInput, acks: Record<string, number>): Pick<AttentionFields, "bucket" | "reason"> {
	if (session.permissions?.length) return { bucket: "NEEDS_YOU", reason: "permission" };
	const status = lifecycleStatus(session.status);
	const real = session.turnState !== undefined;
	if (session.turnState === "prompt") return { bucket: "NEEDS_YOU", reason: "prompt" };
	if (real ? session.turnState === "running" : status === "thinking" || status.startsWith("tool:")) return { bucket: "WORKING", reason: null };
	const at = real ? session.lastAgentEnd : session.lastActivity;
	const returned = (real ? session.turnState === "returned" : status === "idle") && at != null && Number.isFinite(at);
	const acked = Object.hasOwn(acks, session.id) && acks[session.id] === at;
	if (returned && !acked) {
		if (real && session.lastAgentEndError) return { bucket: "NEEDS_YOU", reason: "error" };
		if (session.todos && session.todos.total > 0 && session.todos.total > session.todos.completed) return { bucket: "NEEDS_YOU", reason: "question" };
		return { bucket: "REVIEW", reason: "done" };
	}
	return { bucket: "PARKED", reason: null };
}

export function attentionFields(session: AttentionInput, acks: Record<string, number>): AttentionFields {
	const state = classify(session, acks);
	const at = session.turnState !== undefined ? session.lastAgentEnd ?? null
		: Number.isFinite(session.lastActivity) ? session.lastActivity : null;
	const enteredAt = session.turnState !== undefined ? session.enteredStateAt ?? 0 : at ?? 0;
	const risk = session.permissions?.some(item => item.risk === "high") ? "high"
		: session.permissions?.length && session.permissions.every(item => item.risk === "low") ? "low" : undefined;
	const displayName = (!session.runtimeFallbackAlias && session.name?.trim())
		|| (session.runtimeFallbackAlias && session.todos?.current) || basename(session.cwd) || session.cwd || session.id.slice(0, 8);
	return { ...state, displayName, lastAgentEnd: at, enteredStateAt: enteredAt,
		waitingSince: state.bucket === "NEEDS_YOU" ? enteredAt : null, ...(risk ? { risk } : {}) };
}

const MAX_STATE_BYTES = 1024 * 1024;

async function readState(file: string): Promise<Record<string, unknown> & { acks: Record<string, number> }> {
	let text: string;
	try {
		const handle = await open(file, "r");
		try {
			const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead === buffer.length) throw new Error("Hub acknowledgement state is too large");
			text = buffer.toString("utf8", 0, bytesRead);
		} finally { await handle.close(); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { acks: Object.create(null) };
		throw error;
	}
	let value;
	try { value = JSON.parse(text); }
	catch { throw new Error("Invalid Hub acknowledgement JSON; refusing to overwrite it"); }
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| (value.acks !== undefined && (!value.acks || typeof value.acks !== "object" || Array.isArray(value.acks)))
		|| Object.values(value.acks ?? {}).some(at => typeof at !== "number" || !Number.isFinite(at) || at < 0)) {
		throw new Error("Invalid Hub acknowledgement state; refusing to overwrite it");
	}
	return { ...value, acks: Object.assign(Object.create(null), value.acks ?? {}) };
}

/** Atomic, serialized persistence; reserve other session.json keys for Phase 5. */
export async function openAcknowledgements(file: string) {
	let state = await readState(file);
	let writes = Promise.resolve();
	return {
		get: () => state.acks,
		set(id: string, at: number): Promise<void> {
			if (!Number.isFinite(at) || at < 0) return Promise.reject(new Error("Invalid acknowledgement timestamp"));
			const transaction = writes.then(async () => {
				const disk = await readState(file);
				const next = { ...disk, acks: { ...disk.acks, ...state.acks, [id]: at } };
				const serialized = JSON.stringify(next);
				if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error("Hub acknowledgement state is too large");
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				const temporary = `${file}.${randomUUID()}.tmp`;
				try {
					await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
					await rename(temporary, file);
					state = next;
				} finally { await unlink(temporary).catch(() => {}); }
			});
			writes = transaction.catch(() => {});
			return transaction;
		},
		flush: () => writes,
	};
}
