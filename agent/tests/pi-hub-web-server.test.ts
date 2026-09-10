import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
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
	assert.deepEqual(hub.focused, []);
});

test("SSE sends an initial snapshot, updates live, and releases subscriptions on close", async (t) => {
	const hub = await fixture(t);
	const stream = await event(await hub.get("/api/events"));
	assert.deepEqual((await stream.next()).sessions, [SESSION]);
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
	const hub = await fixture(t, { idleMs: 100, onStop: () => { didStop = true; } });
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
	await fixture(t, { idleMs: 50, onStop: () => { idleStopped = true; } });
	await sleep(150);
	assert.equal(idleStopped, true);
	const hub = await fixture(t);
	assert.equal((await hub.post("/api/stop", {}, { Origin: "http://evil.example" })).status, 403);
	assert.equal((await hub.get("/api/health")).status, 200);
	assert.equal((await hub.post("/api/stop", {})).status, 200);
	await sleep(30);
	await assert.rejects(hub.get("/api/health"));
});
