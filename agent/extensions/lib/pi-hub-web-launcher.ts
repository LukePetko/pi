import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export interface HubEndpoint {
	version: 1;
	pid: number;
	origin: string;
	token: string;
}

export function hubStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const agentDir = resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
	const scope = env.PI_INTERCOM_SCOPE_ID?.trim() ?? "";
	const key = createHash("sha256").update(scope).digest("hex").slice(0, 16);
	return join(agentDir, "cache", "hub-web", key);
}

export function hubRuntimeCommand(): { command: string; args: string[] } {
	const directory = dirname(fileURLToPath(import.meta.url));
	const require = createRequire(join(directory, "../../npm/node_modules/pi-intercom/package.json"));
	return {
		command: process.versions.bun ? "node" : process.execPath,
		args: ["--import", require.resolve("tsx"), join(directory, "pi-hub-web-main.ts")],
	};
}

export async function readEndpoint(path: string): Promise<HubEndpoint | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
			typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
			typeof value.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)) return undefined;
		const port = Number(new URL(value.origin).port);
		return port > 0 && port <= 65535 ? value : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function healthy(endpoint: HubEndpoint): Promise<boolean> {
	try {
		const response = await fetch(`${endpoint.origin}/api/health`, {
			headers: { Authorization: `Bearer ${endpoint.token}` },
			signal: AbortSignal.timeout(1_000),
			redirect: "error",
		});
		if (!response.ok) return false;
		const value = await response.json();
		return value.service === "pi-hub-web" && value.version === 1 && value.pid === endpoint.pid;
	} catch { return false; }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
	const deadline = Date.now() + 20_000;
	const id = randomUUID();
	while (Date.now() < deadline) {
		try {
			const file = await open(path, "wx", 0o600);
			try { await file.writeFile(JSON.stringify({ pid: process.pid, id })); }
			finally { await file.close(); }
			return async () => {
				try {
					const owner = JSON.parse(await readFile(path, "utf8"));
					if (owner.id === id) await unlink(path);
				} catch { /* Already removed during shutdown. */ }
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		// Reap crashed launchers only after a grace period; never steal a live lock.
		try {
			const before = await stat(path);
			if (Date.now() - before.mtimeMs > 30_000) {
				let alive = false;
				try {
					const owner = JSON.parse(await readFile(path, "utf8"));
					alive = Number.isSafeInteger(owner.pid) && owner.pid > 1 && isAlive(owner.pid);
				} catch { /* Incomplete lock left by a crashed writer. */ }
				const now = await stat(path);
				if (!alive && before.ino === now.ino && before.mtimeMs === now.mtimeMs) await unlink(path);
			}
		} catch { /* Another launcher released it. */ }
		await sleep(100);
	}
	throw new Error("Hub startup is locked by another Pi. Retry in a moment.");
}

function spawnBridge(endpointFile: string): ChildProcess {
	const runtime = hubRuntimeCommand();
	const child = spawn(runtime.command, [...runtime.args, "--serve", endpointFile], {
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.unref();
	return child;
}

/** Serialize launch attempts across Pi instances; reuse only authenticated endpoints. */
export async function ensureHubWeb(stateDir = hubStateDir()): Promise<HubEndpoint> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	await chmod(stateDir, 0o700);
	const endpointFile = join(stateDir, "endpoint.json");
	const running = await readEndpoint(endpointFile);
	if (running && await healthy(running)) return running;
	const release = await acquireLock(join(stateDir, "launch.lock"));
	try {
		const previous = await readEndpoint(endpointFile);
		if (previous && await healthy(previous)) return previous;
		if (previous && isAlive(previous.pid)) {
			throw new Error("The Hub process is alive but unresponsive. Stop it before reopening.");
		}
		const child = spawnBridge(endpointFile);
		let failure = "";
		let spawnFailed = false;
		child.on("error", (error) => { failure = error.message; spawnFailed = true; });
		child.stderr?.on("data", (data) => { failure = (failure + data.toString()).slice(-2000); });
		try {
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				if (spawnFailed || child.exitCode !== null || child.signalCode !== null) break;
				const endpoint = await readEndpoint(endpointFile);
				if (endpoint && endpoint.pid === child.pid && await healthy(endpoint)) return endpoint;
				await sleep(100);
			}
			child.kill("SIGTERM");
			throw new Error(`Could not start Pi Hub web${failure ? `: ${failure}` : " (startup timed out)"}`);
		} finally {
			// No pipe back to the launching Pi: the server survives its exit/reload.
			child.stderr?.destroy();
		}
	} finally { await release(); }
}

export async function stopHubWeb(stateDir = hubStateDir()): Promise<boolean> {
	const endpoint = await readEndpoint(join(stateDir, "endpoint.json"));
	if (!endpoint || !await healthy(endpoint)) return false;
	const response = await fetch(`${endpoint.origin}/api/stop`, {
		method: "POST",
		headers: { Authorization: `Bearer ${endpoint.token}`, Origin: endpoint.origin },
		signal: AbortSignal.timeout(3_000),
		redirect: "error",
	});
	if (!response.ok) throw new Error("Could not stop Pi Hub web");
	return true;
}
