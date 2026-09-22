import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionFields } from "../extensions/lib/hub-attention.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";

const TOKEN = "a".repeat(64);
const SESSION = { id: "session-1", name: "<script>alert(1)</script>", cwd: "/project", model: "test", pid: 1234, startedAt: 1, lastActivity: 2, status: "idle" };

async function fixture(t, options = {}) {
	let state = { connected: true, sessions: [SESSION] };
	const listeners = new Set<() => void>();
	const focused = [];
	const server = await startHubServer({
		token: TOKEN,
		source: {
			snapshot: () => state,
			subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
			resolveSession: async (id) => state.connected ? state.sessions.find((session) => session.id === id) : undefined,
		},
		focus: async (pid) => { focused.push(pid); },
		...options,
	});
	t.after(() => server.close());
	return {
		...server,
		focused,
		listeners,
		update(value) { state = value; for (const listener of listeners) listener(); },
		get(path, headers = {}) {
			return fetch(`${server.origin}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, signal: AbortSignal.timeout(5_000) });
		},
		post(path: string, body: unknown = { id: SESSION.id }, headers = {}) {
			return fetch(`${server.origin}${path}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${TOKEN}`, Origin: server.origin, "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(5_000),
			});
		},
	};
}

async function event(response) {
	const reader = response.body.getReader();
	let buffer = "";
	return {
		reader,
		async next() {
			while (!buffer.includes("\n\n")) {
				const part = await reader.read();
				assert.equal(part.done, false);
				buffer += new TextDecoder().decode(part.value);
			}
			const index = buffer.indexOf("\n\n");
			const frame = buffer.slice(0, index);
			buffer = buffer.slice(index + 2);
			return JSON.parse(frame.slice(6));
		},
	};
}

test("serves only bundled assets, with CSP and no embedded credentials or session data", async (t) => {
	const hub = await fixture(t);
	for (const path of ["/", "/app.js", "/style.css"]) {
		const response = await hub.get(path, { Authorization: "" });
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal(response.headers.get("referrer-policy"), "no-referrer");
		assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
		const body = await response.text();
		assert.equal(body.includes(TOKEN), false);
		assert.equal(body.includes(SESSION.name), false);
	}
	assert.equal((await hub.get("/endpoint.json")).status, 404);
	assert.equal((await hub.get("/../pi-hub-web-server.ts")).status, 404);
});

test("protects every API, rejects cross-origin requests and DNS rebinding", async (t) => {
	const hub = await fixture(t);
	for (const path of ["/api/events", "/api/health"]) {
		assert.equal((await hub.get(path, { Authorization: "" })).status, 401);
		assert.equal((await hub.get(path, { Authorization: `Bearer ${"b".repeat(64)}` })).status, 401);
		assert.equal((await hub.get(path, { Origin: "http://evil.example" })).status, 403);
		assert.equal((await hub.get(path, { "Sec-Fetch-Site": "cross-site" })).status, 403);
	}
	const status = await new Promise((resolve, reject) => {
		const req = request(`${hub.origin}/api/health`, { headers: { Host: "evil.example", Authorization: `Bearer ${TOKEN}` } }, (res) => { res.resume(); resolve(res.statusCode); });
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
	assert.equal((await hub.post("/api/focus", undefined, { Origin: "" })).status, 404);
	assert.equal((await hub.post("/api/focus", undefined, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await hub.post("/api/focus", undefined, { Authorization: "" })).status, 401);
	assert.equal((await hub.post("/api/ack", undefined, { Authorization: "" })).status, 401);
	assert.equal((await hub.post("/api/ack", undefined, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await hub.post("/api/ack", undefined, { Origin: "" })).status, 404);
	assert.deepEqual(hub.focused, []);
});

test("SSE sends an initial snapshot, updates live, and releases subscriptions on close", async (t) => {
	const hub = await fixture(t);
	const stream = await event(await hub.get("/api/events"));
	assert.deepEqual((await stream.next()).sessions, [{ ...SESSION, permissions: [], ...attentionFields(SESSION, {}) }]);
	hub.update({ connected: true, sessions: [{ ...SESSION, status: "thinking", contextPct: 30 }] });
	assert.equal((await stream.next()).sessions[0].status, "thinking");
	hub.update({ connected: false, sessions: [] });
	assert.deepEqual(await stream.next(), { connected: false, sessions: [] });
	await stream.reader.cancel();
	await hub.close();
	assert.equal(hub.listeners.size, 0);
});

test("focus resolves a live session ID; arbitrary PIDs and stale IDs cannot execute", async (t) => {
	const hub = await fixture(t);
	assert.equal((await hub.post("/api/focus")).status, 200);
	assert.deepEqual(hub.focused, [1234]);
	assert.equal((await hub.post("/api/focus", { pid: 9999 })).status, 400);
	assert.equal((await hub.post("/api/focus", { id: "unknown", pid: 9999 })).status, 404);
	assert.equal((await hub.post("/api/focus", { id: "x".repeat(257) })).status, 400);
	assert.equal((await hub.post("/api/focus", undefined, { "Content-Type": "text/plain" })).status, 415);
	hub.update({ connected: true, sessions: [] });
	assert.equal((await hub.post("/api/focus")).status, 404);
	assert.deepEqual(hub.focused, [1234]);
});

test("focus failures are bounded responses and concurrent focus requests are rejected", async (t) => {
	let release;
	let entered;
	const started = new Promise((resolve) => { entered = resolve; });
	const hub = await fixture(t, { focus: async () => { entered(); await new Promise((resolve) => { release = resolve; }); throw new Error("private system detail"); } });
	const first = hub.post("/api/focus");
	await started;
	assert.equal((await hub.post("/api/focus")).status, 429);
	release();
	const response = await first;
	assert.equal(response.status, 503);
	assert.equal((await response.text()).includes("private system detail"), false);
});

test("an open dashboard prevents idle shutdown; closing it starts the idle countdown", async (t) => {
	let didStop = false;
	const hub = await fixture(t, { lifetime: "browser-idle", idleMs: 100, onStop: () => { didStop = true; } });
	const stream = await event(await hub.get("/api/events"));
	await stream.next();
	await sleep(200);
	assert.equal(didStop, false);
	await stream.reader.cancel();
	await sleep(200);
	assert.equal(didStop, true);
});

test("idle startup and authenticated explicit stop both shut down the server", async (t) => {
	let idleStopped = false;
	await fixture(t, { lifetime: "browser-idle", idleMs: 50, onStop: () => { idleStopped = true; } });
	await sleep(150);
	assert.equal(idleStopped, true);
	const hub = await fixture(t);
	assert.equal((await hub.post("/api/stop", {}, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await hub.get("/api/health")).status, 200);
	assert.equal((await hub.post("/api/stop", {})).status, 200);
	await sleep(30);
	await assert.rejects(hub.get("/api/health"));
});

test("Accept persists acks, parks only that completion, and survives a Hub restart", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-ack-api-")); t.after(() => rm(root, { recursive: true, force: true }));
	const stateFile = join(root, "session.json");
	const hub = await fixture(t, { stateFile });
	const accepted = await hub.post("/api/ack", { id: SESSION.id, lastAgentEnd: 2 });
	assert.equal(accepted.status, 200);
	assert.equal((await accepted.json()).snapshot.sessions[0].bucket, "PARKED");
	assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
	await hub.close();
	const restarted = await fixture(t, { stateFile });
	const stream = await event(await restarted.get("/api/events"));
	assert.equal((await stream.next()).sessions[0].bucket, "PARKED");
	restarted.update({ connected: true, sessions: [{ ...SESSION, lastActivity: 3 }] });
	assert.equal((await stream.next()).sessions[0].bucket, "REVIEW");
	assert.equal((await restarted.post("/api/ack", { id: SESSION.id, lastAgentEnd: 2 })).status, 409);
	assert.equal((await restarted.post("/api/ack", { id: SESSION.id, lastAgentEnd: "3" })).status, 400);
	assert.equal((await restarted.post("/api/ack", { id: "missing" })).status, 404);
	restarted.update({ connected: true, sessions: [{ ...SESSION, status: "thinking", lastActivity: 4 }] });
	assert.equal((await restarted.post("/api/ack")).status, 409);
	restarted.update({ connected: true, sessions: [{ ...SESSION, permissions: [{ id: "p", title: "Wait" }] }] });
	assert.equal((await restarted.post("/api/ack")).status, 409);
	assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).acks, { [SESSION.id]: 2 });
	await stream.reader.cancel();
});

test("ack writes serialize; failed persistence cannot silently park a session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-ack-write-")); t.after(() => rm(root, { recursive: true, force: true }));
	const stateFile = join(root, "session.json");
	const hub = await fixture(t, { stateFile });
	hub.update({ connected: true, sessions: [SESSION, { ...SESSION, id: "second", lastActivity: 3 }] });
	const results = await Promise.all([hub.post("/api/ack", { id: SESSION.id }), hub.post("/api/ack", { id: "second" })]);
	assert.deepEqual(results.map(r => r.status), [200, 200]);
	assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).acks, { [SESSION.id]: 2, second: 3 });
	await writeFile(stateFile, "corrupt");
	hub.update({ connected: true, sessions: [{ ...SESSION, lastActivity: 5 }] });
	assert.equal((await hub.post("/api/ack")).status, 503);
	const stream = await event(await hub.get("/api/events"));
	assert.equal((await stream.next()).sessions[0].bucket, "REVIEW");
	assert.equal(await readFile(stateFile, "utf8"), "corrupt");
	await stream.reader.cancel();
	assert.equal((await hub.post("/api/reply", { id: SESSION.id, text: "not implemented" })).status, 404);
	assert.equal((await hub.get("/api/session")).status, 404);
});

test("an acknowledgement response cannot roll newer working presence back to Parked", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-ack-race-")); t.after(() => rm(root, { recursive: true, force: true }));
	let readsAfterResolve = 0;
	const hub = await fixture(t, { stateFile: join(root, "session.json"), source: {
		snapshot: () => {
			if (readsAfterResolve) readsAfterResolve++;
			return { connected: true, sessions: [readsAfterResolve >= 3 ? { ...SESSION, status: "thinking", lastActivity: 3 } : SESSION] };
		},
		subscribe: () => () => {},
		resolveSession: async () => { readsAfterResolve = 1; return SESSION; },
	} });
	const response = await hub.post("/api/ack", { id: SESSION.id, lastAgentEnd: 2 });
	assert.equal(response.status, 200);
	const value = (await response.json()).snapshot.sessions[0];
	assert.equal(value.bucket, "WORKING");
	assert.equal(value.lastActivity, 3);
	assert.deepEqual(JSON.parse(await readFile(join(root, "session.json"), "utf8")).acks, { [SESSION.id]: 2 });
});

test("a stale roster lookup cannot acknowledge newer work already observed by the source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-ack-stale-")); t.after(() => rm(root, { recursive: true, force: true }));
	let advanced = false;
	const hub = await fixture(t, { stateFile: join(root, "session.json"), source: {
		snapshot: () => ({ connected: true, sessions: [advanced ? { ...SESSION, status: "thinking", lastActivity: 3 } : SESSION] }),
		subscribe: () => () => {},
		resolveSession: async () => { advanced = true; return SESSION; },
	} });
	assert.equal((await hub.post("/api/ack", { id: SESSION.id, lastAgentEnd: 2 })).status, 409);
	await assert.rejects(readFile(join(root, "session.json")), { code: "ENOENT" });
});
