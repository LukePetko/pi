import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve, isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runHubCommand } from "../hub.ts";
import { healthy, hubRuntimeCommand, hubStateDir, hubStatus, readEndpoint, startHubWeb, stopHubWeb } from "../extensions/lib/pi-hub-web-launcher.ts";
import { logHubLifecycle, readControl, withHubControl, writeDesired } from "../extensions/lib/pi-hub-service-control.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";

for (const scenario of ["construction-resumes", "construction-stalls", "publication-resumes"]) {
	test(`signal shutdown is monotonic while ${scenario}`, { timeout: 10_000 }, async (t) => {
		const directory = await mkdtemp("/tmp/hub-startup-stop-");
		t.after(() => rm(directory, { recursive: true, force: true }));
		await writeDesired(directory, "running");
		const control = await readControl(directory);
		const endpointFile = join(directory, "endpoint.json");
		const hook = join(directory, "startup-hook.mjs");
		await writeFile(hook, `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const method = ${JSON.stringify(scenario === "publication-resumes" ? "writeFile" : "open")};
const original = fs[method];
fs[method] = async function(path, ...args) {
  if (String(path)${scenario === "publication-resumes" ? '.includes("endpoint.json.")' : '.endsWith("session.json")'}) {
    const alive = setInterval(() => {}, 100);
    process.stdout.write("startup-blocked\\n");
    await new Promise((resolve) => {
      ${scenario === "construction-stalls" ? "" : 'process.once("SIGTERM", () => setTimeout(resolve, 50));'}
    });
    clearInterval(alive);
  }
  return original.call(this, path, ...args);
};
syncBuiltinESMExports();
`);
		const runtime = hubRuntimeCommand();
		const child = spawn(runtime.command, ["--import", hook, ...runtime.args, "--serve", endpointFile], {
			env: { ...process.env, PI_CODING_AGENT_DIR: directory, PI_INTERCOM_SCOPE_ID: "startup-stop", PI_HUB_PORT: "0" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = once(child, "exit");
		t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; });
		let stderr = "";
		child.stderr.on("data", (data) => { stderr += data; });
		await Promise.race([
			once(child.stdout, "data").then(([data]) => assert.match(String(data), /startup-blocked/)),
			exited.then(() => { throw new Error(`Unexpected startup exit: ${stderr}`); }),
		]);
		const stoppedAt = Date.now();
		child.kill("SIGTERM");
		assert.deepEqual(await exited, [0, null], stderr);
		assert.ok(Date.now() - stoppedAt < 4_000, "bounded shutdown even when startup never resumes");
		assert.equal(await readEndpoint(endpointFile), undefined, "must never leave a published late instance");
		assert.deepEqual(await readControl(directory), control, "signal must not change user intent");
		const log = await readFile(join(directory, "service.log.json"), "utf8").catch(() => "");
		assert.equal(log.includes("started resident service"), false);
		if (scenario !== "construction-stalls") assert.match(log, /stopped/);
	});
}

const execute = promisify(execFile);
const cli = resolve("agent/hub.ts");
const launcher = pathToFileURL(resolve("agent/extensions/lib/pi-hub-web-launcher.ts")).href;

async function fixture(t) {
	const dir = await mkdtemp("/tmp/hub-resident-");
	const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_INTERCOM_SCOPE_ID: "resident-test", PI_HUB_PORT: "0" };
	const state = hubStateDir(env);
	t.after(async () => {
		await stopHubWeb(state).catch(() => {});
		await sleep(5_500); // Isolated broker exits after its last client.
		await rm(dir, { recursive: true, force: true });
	});
	const command = (command: string) => execute(process.execPath, ["--experimental-strip-types", cli, command], { env, timeout: 45_000 });
	const ensure = () => execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import {ensureHubWeb} from ${JSON.stringify(launcher)}; await ensureHubWeb();`], { env, timeout: 45_000 });
	return { dir, env, state, command, ensure, endpoint: () => readEndpoint(join(state, "endpoint.json")) };
}

test("resident server persists without Pi, browser or source; explicit legacy idle still exits", async (t) => {
	const dir = await mkdtemp("/tmp/hub-lifetime-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	const source = { snapshot: () => ({ connected: false, sessions: [] }), subscribe: () => () => {}, resolveSession: async () => undefined };
	let stopped = false;
	const hub = await startHubServer({ token: "a".repeat(64), source, focus: async () => {}, idleMs: 20, stateFile: join(dir, "session.json"), onStop: () => { stopped = true; } });
	t.after(() => hub.close());
	await sleep(100);
	assert.equal(stopped, false);
	const headers = { Authorization: `Bearer ${"a".repeat(64)}` };
	const response = await fetch(`${hub.origin}/api/events`, { headers });
	await response.body!.cancel();
	await sleep(100);
	const health = await (await fetch(`${hub.origin}/api/health`, { headers })).json();
	assert.equal(health.mode, "resident");
	assert.equal(health.connected, false);
	assert.equal(stopped, false);
	let idleStopped = false;
	const legacy = await startHubServer({ token: "b".repeat(64), source, focus: async () => {}, lifetime: "browser-idle", idleMs: 20, stateFile: join(dir, "legacy.json"), onStop: () => { idleStopped = true; } });
	t.after(() => legacy.close());
	await sleep(100);
	assert.equal(idleStopped, true);
});

test("standalone concurrent starts survive launchers; stop is sticky, crash restart preserves intent and acks", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	assert.equal(JSON.parse((await f.command("status")).stdout).service, "absent");
	await assert.rejects(stat(f.state), { code: "ENOENT" }, "status must not create state");
	const starts = await Promise.all([f.command("start"), f.command("start")]);
	assert.equal(starts[0].stdout, starts[1].stdout);
	let endpoint = (await f.endpoint())!;
	await sleep(200);
	assert.equal(await healthy(endpoint), true, "survives both parent processes without browser");
	for (const name of ["endpoint.json", "control.json", "service.log.json"]) assert.equal((await stat(join(f.state, name))).mode & 0o777, 0o600);
	assert.equal((await stat(f.state)).mode & 0o777, 0o700);
	const original = endpoint;
	assert.equal(await healthy({ ...endpoint, instance: "0".repeat(36) }), false);
	assert.equal(await healthy({ ...endpoint, capabilities: [] }), false);
	assert.equal(await healthy({ ...endpoint, token: "0".repeat(64) }), false);
	assert.ok(isAbsolute(hubRuntimeCommand().command));
	assert.ok(hubRuntimeCommand().args.slice(1).every(isAbsolute));
	let opened = "";
	await runHubCommand(["open"], { stateDir: f.state, open: async (url) => { opened = url; } });
	assert.equal(opened, `${endpoint.origin}/#${endpoint.token}`);
	await f.command("stop");
	assert.equal(await healthy(endpoint), false);
	assert.equal((await readControl(f.state))?.desired, "stopped");
	await assert.rejects(f.ensure(), /stopped by user/);
	assert.deepEqual(JSON.parse((await f.command("status")).stdout), { desired: "stopped", service: "absent", connected: null, autostart: "not-managed" });
	const acks = '{"version":1,"acks":{"existing":42},"extra":"preserve"}';
	await writeFile(join(f.state, "session.json"), acks, { mode: 0o600 });
	await f.command("start");
	endpoint = (await f.endpoint())!;
	assert.notEqual(endpoint.instance, original.instance);
	process.kill(endpoint.pid, "SIGKILL"); // Only the isolated authenticated fixture process.
	for (let i = 0; i < 50 && await healthy(endpoint); i++) await sleep(20);
	assert.equal((await readControl(f.state))?.desired, "running");
	await f.ensure();
	const restarted = (await f.endpoint())!;
	assert.notEqual(restarted.instance, endpoint.instance);
	assert.equal(await healthy(restarted), true);
	await f.command("stop");
	assert.equal(await readFile(join(f.state, "session.json"), "utf8"), acks);
	await f.command("stop");
	await assert.rejects(f.ensure(), /stopped by user/);
});

test("authenticated API stop and simultaneous automatic ensures cannot resurrect service", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	await f.command("start");
	const endpoint = (await f.endpoint())!;
	const stop = fetch(`${endpoint.origin}/api/stop`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, Origin: endpoint.origin } });
	await Promise.allSettled([f.ensure(), f.ensure()]);
	assert.equal((await stop).status, 200);
	await withHubControl(f.state, async () => {});
	await assert.rejects(f.ensure(), /stopped by user/);
	assert.equal(await healthy(endpoint), false);
	assert.equal((await readControl(f.state))?.desired, "stopped");
});

test("stop racing an in-flight standalone launch leaves stopped intent", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const start = f.command("start");
	for (let i = 0; i < 100; i++) {
		if (await stat(join(f.state, "launch.lock")).then(() => true, () => false)) break;
		await sleep(10);
	}
	await f.command("stop");
	await start;
	await assert.rejects(f.ensure(), /stopped by user/);
	assert.equal((await hubStatus(f.state)).service, "absent");
});

test("unverified/reused PID is never killed or adopted; corrupt intent fails closed; diagnostics bounded", async (t) => {
	const dir = await mkdtemp("/tmp/hub-private-");
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "endpoint.json"), JSON.stringify({ version: 1, pid: process.pid, token: "a".repeat(64), origin: "http://127.0.0.1:1" }));
	await assert.rejects(startHubWeb(dir), /unverified/);
	await assert.rejects(stopHubWeb(dir), /No process was killed/);
	assert.equal((await hubStatus(dir)).desired, "stopped");
	assert.equal((await hubStatus(dir)).service, "unhealthy-or-unverified");
	await writeFile(join(dir, "control.json"), "invalid");
	await assert.rejects(startHubWeb(dir));
	for (let i = 0; i < 30; i++) await logHubLifecycle(dir, "x".repeat(1000));
	assert.ok((await readFile(join(dir, "service.log.json"), "utf8")).length < 17_000);
});

test("authenticated legacy service is incompatible, not silently adopted", async (t) => {
	const dir = await mkdtemp("/tmp/hub-legacy-");
	const server = createServer((_req, res) => res.end(JSON.stringify({ service: "pi-hub-web", version: 1, pid: process.pid })));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
	const address = server.address() as { port: number };
	await writeFile(join(dir, "endpoint.json"), JSON.stringify({ version: 1, pid: process.pid, token: "a".repeat(64), origin: `http://127.0.0.1:${address.port}` }));
	assert.equal((await hubStatus(dir)).service, "incompatible");
	await assert.rejects(startHubWeb(dir), /Incompatible/);
	await assert.rejects(stopHubWeb(dir), /incompatible/);
});

test("delayed launcher stop is fenced against a newer start and direct API stop/replacement", { timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	await f.command("start");
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	async function delayedStop(replace: boolean) {
		const endpoint = (await f.endpoint())!;
		let arrived!: () => void;
		const arrival = new Promise<void>((resolve) => { arrived = resolve; });
		let resume!: () => void;
		const delay = new Promise<void>((resolve) => { resume = resolve; });
		globalThis.fetch = async (input, init) => {
			if (String(input).endsWith("/api/stop") && new Headers(init?.headers).has("X-Pi-Hub-Control-Revision")) {
				arrived();
				await delay;
			}
			return originalFetch(input, init);
		};
		const stopping = stopHubWeb(f.state);
		await arrival;
		const stoppedRevision = (await readControl(f.state))!.revision;
		if (replace) {
			// A direct API user stop can finish the old instance while a launcher request is delayed.
			const response = await originalFetch(`${endpoint.origin}/api/stop`, { method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, Origin: endpoint.origin } });
			assert.equal(response.status, 200);
			await withHubControl(f.state, async () => {});
		}
		await f.command("start");
		const current = (await f.endpoint())!;
		const running = await readControl(f.state);
		assert.equal(running!.desired, "running");
		assert.notEqual(running!.revision, stoppedRevision);
		assert.equal(current.instance === endpoint.instance, !replace);
		const rejected = assert.rejects(stopping, replace ? /fetch failed/ : /superseded/);
		resume();
		await rejected;
		globalThis.fetch = originalFetch;
		assert.deepEqual(await readControl(f.state), running, "stale stop must not overwrite newer intent");
		assert.equal(await healthy(current), true, "newer start/replacement must remain running");
	}
	await delayedStop(false);
	await delayedStop(true);
});
