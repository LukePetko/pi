import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { healthy, hubRuntimeCommand, hubStateDir, readEndpoint, stopHubWeb } from "../extensions/lib/pi-hub-web-launcher.ts";

const execute = promisify(execFile);
const launcherUrl = pathToFileURL(resolve("agent/extensions/lib/pi-hub-web-launcher.ts")).href;
const clientUrl = pathToFileURL(resolve("agent/npm/node_modules/pi-intercom/broker/client.ts")).href;

test("scopes get distinct private runtime directories", () => {
	assert.equal(hubStateDir({ PI_CODING_AGENT_DIR: "/tmp/agent", PI_INTERCOM_SCOPE_ID: " a " }), hubStateDir({ PI_CODING_AGENT_DIR: "/tmp/agent", PI_INTERCOM_SCOPE_ID: "a" }));
	assert.notEqual(hubStateDir({ PI_INTERCOM_SCOPE_ID: "a" }), hubStateDir({ PI_INTERCOM_SCOPE_ID: "b" }));
	assert.notEqual(hubStateDir({ PI_CODING_AGENT_DIR: "/tmp/a" }), hubStateDir({ PI_CODING_AGENT_DIR: "/tmp/b" }));
});

test("endpoint discovery rejects malformed data and non-loopback addresses", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-endpoint-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "endpoint.json");
	const endpoint = { version: 1, pid: 1234, origin: "http://127.0.0.1:12345", token: "a".repeat(64) };
	for (const bad of ["{", JSON.stringify({ ...endpoint, origin: "http://evil.example:1234" }), JSON.stringify({ ...endpoint, origin: "http://127.0.0.1:99999" }), JSON.stringify({ ...endpoint, token: "short" }), JSON.stringify({ ...endpoint, pid: -1 })]) {
		await writeFile(path, bad);
		assert.equal(await readEndpoint(path), undefined);
	}
	await writeFile(path, JSON.stringify(endpoint));
	assert.deepEqual(await readEndpoint(path), endpoint);
});

test("concurrent launchers reuse one detached server; real scoped Intercom updates reach SSE", { timeout: 40_000 }, async (t) => {
	// Darwin Unix sockets have a short path limit; nested harness TMPDIRs exceed it.
	const dir = await mkdtemp("/tmp/hub-runtime-");
	const env = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_INTERCOM_SCOPE_ID: "hub-test" };
	const stateDir = hubStateDir(env);
	let peer;
	let endpoint;
	let stream;
	t.after(async () => {
		await stream?.cancel().catch(() => {});
		if (peer && peer.exitCode === null) { peer.stdin.end(); await once(peer, "exit"); }
		await stopHubWeb(stateDir).catch(() => {});
		// The isolated broker auto-exits five seconds after its last client leaves.
		await sleep(5_500);
		await rm(dir, { recursive: true, force: true });
	});
	const code = `import { startHubWeb } from ${JSON.stringify(launcherUrl)}; process.stdout.write(JSON.stringify(await startHubWeb()));`;
	const launch = () => execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], { env, timeout: 25_000 });
	const results = await Promise.all([launch(), launch()]);
	endpoint = JSON.parse(results[0].stdout);
	assert.deepEqual(JSON.parse(results[1].stdout), endpoint);
	assert.equal(await healthy(endpoint), true, "server must survive both launcher exits");
	// All control operations now take the lock, including healthy reuse.
	assert.deepEqual(JSON.parse((await launch()).stdout), endpoint);
	assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
	assert.equal((await stat(join(stateDir, "endpoint.json"))).mode & 0o777, 0o600);
	assert.equal((await readFile(join(stateDir, "endpoint.json"), "utf8")).includes(endpoint.token), true);

	const response = await fetch(`${endpoint.origin}/api/events`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
	stream = response.body.getReader();
	let buffer = "";
	async function until(predicate) {
		while (true) {
			if (!buffer.includes("\n\n")) {
				const part = await stream.read();
				assert.equal(part.done, false);
				buffer += new TextDecoder().decode(part.value);
			}
			let boundary;
			while ((boundary = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				if (frame.startsWith("data: ")) {
					const value = JSON.parse(frame.slice(6));
					if (predicate(value)) return value;
				}
			}
		}
	}
	const initial = await until((value) => value.connected);
	assert.deepEqual(initial.sessions, [], "dashboard helper should not list itself");
	const peerCode = `
const module = await import(${JSON.stringify(clientUrl)});
const IntercomClient = module.IntercomClient ?? module.default.IntercomClient;
const client = new IntercomClient();
client.on("error", () => {});
await client.connect({ name: "Browser fixture", model: "test", cwd: "/test-project", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), status: "idle" });
process.stdin.on("data", () => client.updatePresence({ status: "thinking", contextPct: 42 }));
process.stdin.on("end", () => void client.disconnect());
process.stdout.write("ready");
`;
	const runtime = hubRuntimeCommand();
	peer = spawn(runtime.command, [...runtime.args.slice(0, 2), "--input-type=module", "-e", peerCode], { env, stdio: ["pipe", "pipe", "pipe"] });
	let peerError = "";
	peer.stderr.on("data", (data) => { peerError = (peerError + data.toString()).slice(-2000); });
	await Promise.race([
		once(peer.stdout, "data"),
		once(peer, "exit").then(() => { throw new Error(`Test peer exited: ${peerError}`); }),
	]);
	await until((value) => value.sessions.some((session) => session.name === "Browser fixture"));
	peer.stdin.write("update\n");
	const updated = await until((value) => value.sessions.some((session) => session.contextPct === 42));
	assert.equal(updated.sessions[0].status, "thinking");
	peer.stdin.end();
	await once(peer, "exit");
	await until((value) => value.sessions.length === 0);
	const brokerPid = Number((await readFile(join(dir, "intercom", "broker.pid"), "utf8")).trim());
	assert.ok(Number.isSafeInteger(brokerPid) && brokerPid > 1);
	process.kill(brokerPid, "SIGTERM");
	await until((value) => !value.connected);
	await until((value) => value.connected);
	await stream.cancel();
	assert.equal(await stopHubWeb(stateDir), true);
	await sleep(200);
	assert.equal(await healthy(endpoint), false);
	// Simulate a stale discovery file left by an interrupted previous shutdown.
	await writeFile(join(stateDir, "endpoint.json"), JSON.stringify(endpoint), { mode: 0o600 });
	const restarted = JSON.parse((await launch()).stdout);
	assert.notEqual(restarted.token, endpoint.token);
	assert.equal(await healthy(restarted), true);
});
