import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TestContext } from "node:test";

interface CdpResult {
	targetId?: string;
	sessionId?: string;
	data?: string;
	result?: { value?: unknown };
	exceptionDetails?: { text: string };
}
interface CdpMessage {
	id?: number;
	method?: string;
	params?: { exceptionDetails?: unknown };
	error?: { message: string };
	result?: CdpResult;
}
interface PendingCall {
	resolve: (result: CdpResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Minimal CDP driver using Node's WebSocket; no browser automation dependency. */
export async function openTestBrowser(t: TestContext, executable: string) {
	const profile = await mkdtemp("/tmp/pi-hub-chrome-");
	const child = spawn(executable, [
		"--headless=new", "--no-first-run", "--no-default-browser-check",
		"--disable-background-networking", "--disable-sync", "--disable-extensions",
		"--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
	], { stdio: "ignore" });
	let socket: WebSocket | undefined;
	let launchError: Error | undefined;
	child.on("error", (error) => { launchError = error; });
	t.after(async () => {
		socket?.close();
		if (child.exitCode === null && child.pid) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
			await exited;
			clearTimeout(timer);
		}
		await rm(profile, { recursive: true, force: true });
	});
	let address: string | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (launchError) throw launchError;
		try {
			const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
			address = `ws://127.0.0.1:${port}${path}`;
			break;
		} catch { await sleep(100); }
	}
	if (!address) throw new Error("Chrome did not start its debugging endpoint");
	socket = new WebSocket(address);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let sequence = 0;
	let sessionId: string | undefined;
	const pending = new Map<number, PendingCall>();
	const exceptions: unknown[] = [];
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data)) as CdpMessage;
		if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails);
		const task = pending.get(message.id);
		if (!task) return;
		pending.delete(message.id);
		clearTimeout(task.timer);
		if (message.error) task.reject(new Error(message.error.message));
		else task.resolve(message.result);
	});
	function call(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
		return new Promise<CdpResult>((resolve, reject) => {
			const id = ++sequence;
			const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 8_000);
			pending.set(id, { resolve, reject, timer });
			socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	}
	const { targetId } = await call("Target.createTarget", { url: "about:blank" });
	({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
	await call("Page.enable");
	await call("Runtime.enable");
	async function evaluate(expression: string): Promise<unknown> {
		const value = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
		return value.result.value;
	}
	async function waitFor(expression: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await evaluate(expression)) return;
			await sleep(50);
		}
		throw new Error(`Browser condition timed out: ${expression}`);
	}
	return { call, evaluate, waitFor, exceptions };
}
