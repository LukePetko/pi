import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HubTodo {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed";
}
export interface HubTodos {
	total: number;
	completed: number;
	current: string;
	tasks: HubTodo[];
}
export interface TodoIdentity { id: string; pid: number }
const MAX_TASKS = 200;
const MAX_SUBJECT = 256;
const MAX_BYTES = 256 * 1024;

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTodo(value: unknown): value is HubTodo {
	return record(value) && Number.isSafeInteger(value.id) && Number(value.id) > 0
		&& typeof value.subject === "string"
		&& (value.status === "pending" || value.status === "in_progress" || value.status === "completed");
}

/** Only names and status cross into the dashboard: no descriptions or metadata. */
export function projectHubTodos(value: unknown): HubTodos {
	const tasks: HubTodo[] = Array.isArray(value) ? value.filter(isTodo).map((task) => ({
		id: task.id,
		status: task.status,
		subject: task.subject.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, MAX_SUBJECT),
	})) : [];
	const current = tasks.find((task) => task.status === "in_progress")
		?? tasks.find((task) => task.status === "pending") ?? tasks.at(-1);
	return {
		total: tasks.length,
		completed: tasks.filter((task) => task.status === "completed").length,
		current: current?.subject ?? "",
		tasks: tasks.slice(0, MAX_TASKS),
	};
}

function cacheFile(directory: string, identity: TodoIdentity): string {
	const key = JSON.stringify([identity.id, identity.pid]);
	return join(directory, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function writeHubTodos(directory: string, identity: TodoIdentity, tasks: unknown): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = cacheFile(directory, identity);
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({
			version: 1, ...identity, updatedAt: Date.now(), todos: projectHubTodos(tasks),
		}), { mode: 0o600, flag: "wx" });
		await rename(temporary, file);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

function validTodos(value: unknown): value is HubTodos {
	return record(value) && Number.isSafeInteger(value.total) && Number(value.total) >= 0
		&& Number.isSafeInteger(value.completed) && Number(value.completed) >= 0
		&& Number(value.completed) <= Number(value.total)
		&& typeof value.current === "string" && value.current.length <= MAX_SUBJECT
		&& Array.isArray(value.tasks) && value.tasks.length <= MAX_TASKS
		&& value.tasks.length === Math.min(Number(value.total), MAX_TASKS)
		&& value.tasks.every((task) => isTodo(task) && task.subject.length <= MAX_SUBJECT);
}

/** Live roster identity gates cache reads; stale, corrupt, and oversized files are absent. */
export async function readHubTodos(directory: string, session: TodoIdentity & { startedAt: number }): Promise<HubTodos | undefined> {
	try {
		const file = await open(cacheFile(directory, session), "r");
		let contents: string;
		try {
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_BYTES) return undefined;
			contents = buffer.toString("utf8", 0, bytesRead);
		} finally { await file.close(); }
		const data: unknown = JSON.parse(contents);
		if (!record(data) || data.version !== 1 || data.id !== session.id || data.pid !== session.pid
			|| typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt)
			// Session-start hooks can precede Intercom registration by a few milliseconds.
			|| data.updatedAt < session.startedAt - 5_000 || !validTodos(data.todos)) return undefined;
		// Whitelist again so a corrupted cache cannot smuggle unrelated fields into SSE.
		return {
			total: data.todos.total, completed: data.todos.completed, current: data.todos.current,
			tasks: data.todos.tasks.map(({ id, subject, status }) => ({ id, subject, status })),
		};
	} catch { return undefined; }
}

export async function removeHubTodos(directory: string, identity: TodoIdentity): Promise<void> {
	// A replaced process has a different filename, so an old shutdown cannot delete its cache.
	await unlink(cacheFile(directory, identity)).catch(() => {});
}
