import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { HUB_CAPABILITIES, hubRuntimeCommand, readEndpoint } from "./pi-hub-web-launcher.ts";
import { atomicPrivateJson, logHubLifecycle, readControl, withHubControl, writeDesired } from "./pi-hub-service-control.ts";
import { focusPiSession } from "./pi-hub-navigation.ts";
import { startHubServer } from "./pi-hub-web-server.ts";
import { IntercomHubSource } from "./pi-hub-web-source.ts";
import { withHubTodos } from "./hub-todo-source.ts";

const execute = promisify(execFile);

async function focusInWorker(pid: number, signal: AbortSignal): Promise<void> {
	const runtime = hubRuntimeCommand();
	await execute(runtime.command, [...runtime.args, "--focus", String(pid)], {
		timeout: 10_000,
		killSignal: "SIGKILL",
		maxBuffer: 8192,
		signal,
	});
}

async function serve(endpointFile: string): Promise<void> {
	const token = randomBytes(32).toString("hex");
	const instance = randomUUID();
	const stateDir = dirname(endpointFile);
	const source = new IntercomHubSource();
	const shutdown = new AbortController();
	let server: Awaited<ReturnType<typeof startHubServer>> | undefined;
	let stopping = false;
	let stopPromise: Promise<void> | undefined;
	let finishStartup!: () => void;
	const startupFinished = new Promise<void>((resolve) => { finishStartup = resolve; });
	function stop(): Promise<void> {
		if (stopPromise) return stopPromise;
		stopping = true;
		shutdown.abort();
		// Keep the deadline alive even if construction never resumes. Shutdown cannot
		// finish before late-created resources/publication have been accounted for.
		const forceExit = setTimeout(() => process.exit(0), 2_000);
		stopPromise = (async () => {
			await startupFinished;
			await server?.close();
			await source.close();
			const endpoint = await readEndpoint(endpointFile);
			if (endpoint?.token === token) await unlink(endpointFile).catch(() => {});
			await logHubLifecycle(stateDir, "stopped");
			clearTimeout(forceExit);
		})();
		return stopPromise;
	}
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
	async function initialize(): Promise<void> {
		server = await startHubServer({
			source: withHubTodos(source), token, instance, capabilities: HUB_CAPABILITIES, lifetime: "resident",
			stateFile: join(stateDir, "session.json"),
			focus: (pid) => focusInWorker(pid, shutdown.signal),
			requestStop: (close, fence) => withHubControl(stateDir, async () => {
				// Old requests cannot stop a replacement instance or supersede a later start.
				if ((await readEndpoint(endpointFile))?.instance !== instance) return false;
				if (fence) {
					const control = await readControl(stateDir);
					if (fence.instance !== instance || control?.revision !== fence.revision || control.desired !== "stopped") return false;
				} else await writeDesired(stateDir, "stopped");
				await close();
				await stop();
				return true;
			}),
		});
		if (stopping) return;
		await atomicPrivateJson(endpointFile, { version: 1, pid: process.pid, origin: server.origin, token,
			instance, mode: "resident", capabilities: HUB_CAPABILITIES }, shutdown.signal);
		if (stopping) return;
		await logHubLifecycle(stateDir, "started resident service");
		if (!stopping) void source.start();
	}
	try {
		await initialize();
	} catch (error) {
		finishStartup();
		await stop();
		if (!(error instanceof Error && error.name === "AbortError")) throw error;
	} finally { finishStartup(); }
	if (stopping) await stop();
}

async function main(): Promise<void> {
	const [mode, argument] = process.argv.slice(2);
	if (mode === "--serve" && argument) {
		await serve(argument);
	} else if (mode === "--focus" && argument && /^[1-9]\d*$/.test(argument) && Number.isSafeInteger(Number(argument))) {
		focusPiSession(Number(argument), (command, args) => execFileSync(command, args, {
			encoding: "utf8",
			timeout: 1_500,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim());
	} else {
		throw new Error("Expected --serve <endpoint-file> or --focus <pid>");
	}
}

void main().catch(async (error) => {
	const message = error instanceof Error ? error.message : "Pi Hub web failed";
	if (process.argv[2] === "--serve" && process.argv[3]) {
		await logHubLifecycle(dirname(process.argv[3]), `failed: ${message}`).catch(() => {});
	} else process.stderr.write(`${message}\n`);
	process.exit(1);
});
