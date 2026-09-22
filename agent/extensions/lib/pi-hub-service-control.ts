import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface HubControl { version: 1; desired: "running" | "stopped"; revision: string }

export function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function readControl(directory: string): Promise<HubControl | undefined> {
	try {
		const value = JSON.parse(await readFile(join(directory, "control.json"), "utf8"));
		if (value?.version !== 1 || !["running", "stopped"].includes(value.desired) || typeof value.revision !== "string") throw new Error("Invalid Hub control state");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error; // Corrupt intent must never silently clear a user's stop.
	}
}

export async function atomicPrivateJson(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		signal?.throwIfAborted();
		await rename(temporary, path);
	} finally { await unlink(temporary).catch(() => {}); }
}

/** Call only while holding the scoped control lock. */
export async function writeDesired(directory: string, desired: HubControl["desired"]): Promise<HubControl> {
	const control: HubControl = { version: 1, desired, revision: randomUUID() };
	await atomicPrivateJson(join(directory, "control.json"), control);
	return control;
}

/** Serializes explicit start, automatic ensure and both local/API stop transactions. */
export async function withHubControl<T>(directory: string, action: () => Promise<T>): Promise<T> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	const path = join(directory, "launch.lock");
	const deadline = Date.now() + 35_000;
	const id = randomUUID();
	while (true) {
		try {
			const file = await open(path, "wx", 0o600);
			try { await file.writeFile(JSON.stringify({ pid: process.pid, id })); }
			finally { await file.close(); }
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		// Never steal a live lock; tolerate a writer interrupted before its JSON write.
		try {
			const before = await stat(path);
			if (Date.now() - before.mtimeMs > 30_000) {
				let alive = false;
				try {
					const owner = JSON.parse(await readFile(path, "utf8"));
					alive = Number.isSafeInteger(owner.pid) && owner.pid > 1 && isAlive(owner.pid);
				} catch { /* Crashed partial writer. */ }
				const now = await stat(path);
				if (!alive && before.ino === now.ino && before.mtimeMs === now.mtimeMs) await unlink(path);
			}
		} catch { /* Released concurrently. */ }
		if (Date.now() >= deadline) throw new Error("Hub control is locked. Retry in a moment.");
		await sleep(100);
	}
	try { return await action(); }
	finally {
		const owner = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
		if (owner?.id === id) await unlink(path);
	}
}

/** Small private lifecycle diagnostics, not transcripts, tokens or subprocess output. */
export async function logHubLifecycle(directory: string, message: string): Promise<void> {
	const path = join(directory, "service.log.json");
	let previous = "";
	try { previous = JSON.parse(await readFile(path, "utf8")); } catch { /* First run. */ }
	await atomicPrivateJson(path, `${typeof previous === "string" ? previous : ""}${new Date().toISOString()} ${message.slice(0, 1000)}\n`.slice(-16_384));
}
