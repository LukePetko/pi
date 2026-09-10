import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { hubRuntimeCommand, readEndpoint } from "./pi-hub-web-launcher.ts";
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
	const source = new IntercomHubSource();
	const shutdown = new AbortController();
	let server: Awaited<ReturnType<typeof startHubServer>> | undefined;
	let stopping = false;
	async function stop(): Promise<void> {
		if (stopping) return;
		stopping = true;
		shutdown.abort();
		const forceExit = setTimeout(() => process.exit(0), 2_000);
		forceExit.unref();
		await server?.close();
		await source.close();
		const endpoint = await readEndpoint(endpointFile);
		if (endpoint?.token === token) await unlink(endpointFile).catch(() => {});
		process.exit(0);
	}
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
	server = await startHubServer({ source: withHubTodos(source), token, focus: (pid) => focusInWorker(pid, shutdown.signal), onStop: () => void stop() });
	const temporary = `${endpointFile}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ version: 1, pid: process.pid, origin: server.origin, token }), {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, endpointFile);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		await server.close();
		throw error;
	}
	void source.start();
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

void main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : "Pi Hub web failed"}\n`);
	process.exit(1);
});
