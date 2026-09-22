import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isAlive, readControl, withHubControl, writeDesired } from "./pi-hub-service-control.ts";

export const HUB_CAPABILITIES = ["resident-lifecycle-v1", "notifications-v1"];
export interface HubEndpoint {
	version: 1;
	pid: number;
	origin: string;
	token: string;
	instance?: string;
	mode?: "resident" | "browser-idle";
	capabilities?: string[];
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
	let command = process.execPath;
	if (process.versions.bun) {
		command = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).map((entry) => join(entry, "node")).find((entry) => {
			try { accessSync(entry, constants.X_OK); return true; } catch { return false; }
		}) ?? "";
		if (!command) throw new Error("Hub requires an installed Node executable");
	}
	return { command, args: ["--import", require.resolve("tsx"), join(directory, "pi-hub-web-main.ts")] };
}

export async function readEndpoint(path: string): Promise<HubEndpoint | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8"));
		if (value?.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 1 ||
			typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token) ||
			typeof value.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)) return undefined;
		const port = Number(new URL(value.origin).port);
		return port > 0 && port <= 65535 ? value : undefined;
	} catch { return undefined; }
}

export function compatible(endpoint: HubEndpoint): boolean {
	return typeof endpoint.instance === "string" && /^[a-f0-9-]{36}$/.test(endpoint.instance) && endpoint.mode === "resident" &&
		Array.isArray(endpoint.capabilities) && HUB_CAPABILITIES.every((capability) => endpoint.capabilities!.includes(capability));
}

async function probe(endpoint: HubEndpoint): Promise<{ connected: boolean } | undefined> {
	try {
		const response = await fetch(`${endpoint.origin}/api/health`, {
			headers: { Authorization: `Bearer ${endpoint.token}` },
			signal: AbortSignal.timeout(1_000), redirect: "error",
		});
		if (!response.ok) return undefined;
		const value = await response.json();
		if (value.service !== "pi-hub-web" || value.version !== 1 || value.pid !== endpoint.pid ||
			value.instance !== endpoint.instance || value.mode !== endpoint.mode ||
			JSON.stringify(value.capabilities) !== JSON.stringify(endpoint.capabilities)) return undefined;
		return { connected: value.connected === true };
	} catch { return undefined; }
}

export async function healthy(endpoint: HubEndpoint): Promise<boolean> { return !!await probe(endpoint); }

export async function hubStatus(stateDir = hubStateDir()) {
	const control = await readControl(stateDir);
	const endpoint = await readEndpoint(join(stateDir, "endpoint.json"));
	const health = endpoint ? await probe(endpoint) : undefined;
	let service = endpoint ? health ? (compatible(endpoint) ? "running" : "incompatible") : isAlive(endpoint.pid) ? "unhealthy-or-unverified" : "stale" : "absent";
	if (service === "absent" || service === "stale") {
		try {
			const lock = JSON.parse(await readFile(join(stateDir, "launch.lock"), "utf8"));
			if (Number.isSafeInteger(lock.pid) && lock.pid > 1 && isAlive(lock.pid)) service = "control-in-progress";
		} catch { /* Read-only status never repairs a stale lock. */ }
	}
	return { desired: control?.desired ?? "unset", service, connected: health?.connected ?? null, autostart: "not-managed" };
}

async function start(stateDir: string, explicit: boolean): Promise<HubEndpoint> {
	return withHubControl(stateDir, async () => {
		const control = await readControl(stateDir);
		if (!explicit && control?.desired === "stopped") throw new Error("Hub is stopped by user. Use hub start or /hub-web to resume.");
		const endpointFile = join(stateDir, "endpoint.json");
		const previous = await readEndpoint(endpointFile);
		if (previous && await healthy(previous)) {
			if (!compatible(previous)) throw new Error("Incompatible Hub is running; stop the old service before starting this version.");
			if (explicit || !control) await writeDesired(stateDir, "running");
			return previous;
		}
		if (previous && isAlive(previous.pid)) throw new Error("Hub endpoint is unverified but its PID is alive. No process was killed; inspect it before restarting.");
		const runtime = hubRuntimeCommand();
		await writeDesired(stateDir, "running");
		const child = spawn(runtime.command, [...runtime.args, "--serve", endpointFile], {
			detached: true, stdio: "ignore",
			cwd: dirname(fileURLToPath(import.meta.url)),
			env: { ...process.env, PI_CODING_AGENT_DIR: resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), PI_INTERCOM_SCOPE_ID: process.env.PI_INTERCOM_SCOPE_ID?.trim() ?? "" },
		});
		child.unref();
		let failure = "";
		child.on("error", (error) => { failure = error.message; });
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (failure || child.exitCode !== null || child.signalCode !== null) break;
			const endpoint = await readEndpoint(endpointFile);
			if (endpoint && endpoint.pid === child.pid && compatible(endpoint) && await healthy(endpoint)) return endpoint;
			await sleep(100);
		}
		// Only the child we just created, never a PID taken from discovery state.
		child.kill("SIGTERM");
		throw new Error(`Could not start Pi Hub${failure ? `: ${failure}` : "; see private service.log.json (or check Node/tsx installation)"}`);
	});
}

/** Automatic clients must honor explicit stopped intent. */
export async function ensureHubWeb(stateDir = hubStateDir()): Promise<HubEndpoint> { return start(stateDir, false); }
/** Explicit user start/open clears stopped intent. */
export async function startHubWeb(stateDir = hubStateDir()): Promise<HubEndpoint> { return start(stateDir, true); }

export async function stopHubWeb(stateDir = hubStateDir()): Promise<boolean> {
	const transaction = await withHubControl(stateDir, async () => {
		const endpoint = await readEndpoint(join(stateDir, "endpoint.json"));
		const control = await writeDesired(stateDir, "stopped");
		if (endpoint && await healthy(endpoint) && compatible(endpoint)) return { endpoint, revision: control.revision };
		if (endpoint && (await healthy(endpoint) || isAlive(endpoint.pid))) throw new Error("Stopped intent saved, but an incompatible or unverified process remains. No process was killed.");
		return undefined;
	});
	if (!transaction) return false;
	const { endpoint, revision } = transaction;
	// The authenticated service takes the same control lock, checks this intent revision,
	// and closes before releasing it. Do not hold the lock across this request.
	try {
		const response = await fetch(`${endpoint.origin}/api/stop`, {
			method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, Origin: endpoint.origin,
				"X-Pi-Hub-Control-Revision": revision, "X-Pi-Hub-Instance": endpoint.instance! },
			signal: AbortSignal.timeout(40_000), redirect: "error",
		});
		if (response.status === 409) throw new Error("Hub stop superseded by a newer user action");
		if (!response.ok) throw new Error("Could not stop Pi Hub");
	} catch (error) {
		// Another stop (or a crash) may close the endpoint between probe and request.
		const stopped = await withHubControl(stateDir, async () => {
			const current = await readEndpoint(join(stateDir, "endpoint.json"));
			return (await readControl(stateDir))?.desired === "stopped" &&
				(!current || (!await healthy(current) && !isAlive(current.pid)));
		});
		if (!stopped) throw error;
	}
	// Barrier: the API sends its reply before closing connections; wait for its transaction.
	await withHubControl(stateDir, async () => {});
	return true;
}
