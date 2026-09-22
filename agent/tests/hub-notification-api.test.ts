import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";
import { openHubNotifications } from "../extensions/lib/hub-notifications.ts";
import { createHubNotificationClient } from "../extensions/lib/hub-notification-client.ts";
import { NOTIFICATION_API } from "../extensions/lib/hub-notification-protocol.ts";

async function setup(t) {
	const root = await mkdtemp("/tmp/pi-notice-api-"); const sent: any[] = []; const visible = new Set<string>();
	const notifications = await openHubNotifications({ file: join(root, "notices.json"), scope: root, pollMs: 60000,
		sender: { async show(n) { sent.push(structuredClone(n)); visible.add(n.id); }, async remove(n) { visible.delete(n.id); }, async list() { return [...visible]; } },
		authority: { async validate() {}, async focused() { return false; }, async action() {} },
	});
	const token = "a".repeat(64);
	const server = await startHubServer({ token, notifications, stateFile: join(root, "session.json"), focus: async () => {}, source: { snapshot: () => ({ connected: false, sessions: [] }), subscribe: () => () => {}, resolveSession: async () => undefined } });
	t.after(async () => { await server.close(); await notifications.drain(); await rm(root, { recursive: true, force: true }); });
	const endpoint = { version: 1 as const, pid: process.pid, origin: server.origin, token, capabilities: ["notifications-v1"] };
	const origin = { pid: 101, birth: "birth", session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1" };
	const post = (op: string, body: any, headers = {}) => fetch(`${server.origin}${NOTIFICATION_API}${op}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
	return { endpoint, origin, post, notifications, sent, visible, server };
}
test("notification API is bounded/local-only, rejects browser origins and arbitrary executable data, exposes only three routes", async t => {
	const h = await setup(t);
	assert.equal((await h.post("register", h.origin, { Origin: h.endpoint.origin })).status, 403);
	assert.equal((await h.post("register", h.origin, { Origin: "https://foreign.invalid" })).status, 403);
	assert.equal((await h.post("register", h.origin, { "Sec-Fetch-Site": "cross-site" })).status, 403);
	assert.equal((await h.post("register", h.origin, { Authorization: "Bearer wrong" })).status, 401);
	assert.equal((await h.post("register", "x".repeat(9000))).status, 413);
	assert.equal((await h.post("register", { ...h.origin, environment: { PATH: "/tmp" } })).status, 400);
	assert.equal((await h.post("reply", {})).status, 404);
	assert.equal((await h.post("register", h.origin)).status, 200);
	const event = { version: 1, generation: h.origin.generation, bindingSequence: "1", eventId: randomUUID(), kind: "completion", cwd: "/work/project" };
	assert.equal((await h.post("event", event)).status, 200); await h.notifications.drain();
	const n = h.sent[0];
	assert.equal((await h.post("action", { id: n.id, capability: "wrong", action: "show" }, { Authorization: "" })).status, 403);
	assert.equal((await h.post("action", { id: n.id, capability: n.capability, action: "show" }, { Authorization: "" })).status, 200);
	assert.equal(h.visible.size, 0);
	assert.equal((await h.post("action", { id: n.id, capability: n.capability, action: "show" }, { Authorization: "" })).status, 403);
});
test("thin client retries a lost HTTP response with stable ID, heartbeat re-registers quietly and stopped intent never invokes an OS fallback", async t => {
	const h = await setup(t); let lost = false; let registrations = 0; let stopped = false; let ensures = 0;
	const client = createHubNotificationClient({ origin: async () => h.origin, ensure: async () => { ensures++; if (stopped) throw new Error("stopped by user"); return h.endpoint; }, retryMs: 60000, rebindMs: 20, report() {},
		fetch: async (url, options) => { const response = await fetch(url, options); if (String(url).endsWith("register")) registrations++; if (String(url).endsWith("event") && !lost) { lost = true; throw new Error("lost response"); } return response; },
	});
	t.after(() => client.dispose());
	client.send({ version: 1, generation: h.origin.generation, eventId: randomUUID(), kind: "completion", cwd: "/work/project" });
	while (!lost) await new Promise(r => setTimeout(r, 5));
	await client.flush(); await h.notifications.drain(); assert.equal(h.sent.length, 1);
	const before = registrations;
	while (registrations <= before) await new Promise(r => setTimeout(r, 5));
	assert.equal(h.sent.length, 1, "heartbeat does not replay events");
	stopped = true; const previous = ensures; while (ensures <= previous) await new Promise(r => setTimeout(r, 5));
	assert.equal(h.sent.length, 1);
	client.dispose();
});
test("retry queue is bounded to 64, expires at five minutes, and shutdown seals a runtime", async t => {
	let now = 0; let count = 0; let registrations = 0; let offline = true;
	const endpoint = { version: 1 as const, pid: 1, origin: "http://127.0.0.1:1", token: "a".repeat(64), capabilities: ["notifications-v1"] };
	const o = { pid: 101, birth: "birth", session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1" };
	const client = createHubNotificationClient({ origin: async () => o, now: () => now, retryMs: 60000, rebindMs: 60000, report() {}, ensure: async () => { if (offline) throw new Error("offline"); return endpoint; }, fetch: async (url) => { if (String(url).endsWith("register")) registrations++; else count++; return new Response("{}", { status: 200 }); } });
	t.after(() => client.dispose());
	const e = () => ({ version: 1 as const, generation: o.generation, eventId: randomUUID(), kind: "completion" as const, cwd: "/work" });
	for (let i = 0; i < 70; i++) client.send(e());
	await new Promise(r => setImmediate(r)); offline = false; await client.flush(); assert.equal(count, 64);
	offline = true; client.send(e()); await new Promise(r => setImmediate(r)); now = 300001; offline = false; await client.flush(); assert.equal(count, 64);
	client.send({ ...e(), kind: "session-ended" }); await new Promise(r => setImmediate(r)); await client.flush(); client.send(e()); await client.flush(); assert.equal(count, 65); assert.ok(registrations >= 2);
});

test("shutdown supersedes a saturated retry queue and follows an in-flight delivery with its own revoke", async t => {
	const o = { pid: 101, birth: "birth", session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1" };
	let release; let started = false; const wait = new Promise<void>(r => { release = r; }); const kinds: string[] = [];
	const client = createHubNotificationClient({ origin: async () => o, ensure: async () => ({ version: 1, pid: 1, origin: "http://127.0.0.1:1", token: "a".repeat(64), capabilities: ["notifications-v1"] }), retryMs: 60000, rebindMs: 60000, report() {}, fetch: async (url, options) => {
		if (String(url).endsWith("event")) { const e = JSON.parse(String(options?.body)); kinds.push(e.kind); if (kinds.length === 1) { started = true; await wait; } }
		return new Response("{}", { status: 200 });
	} });
	t.after(() => client.dispose());
	const e = () => ({ version: 1 as const, generation: o.generation, eventId: randomUUID(), kind: "completion" as const, cwd: "/work" });
	client.send(e()); while (!started) await new Promise(r => setImmediate(r));
	for (let i = 0; i < 70; i++) client.send(e());
	client.send({ ...e(), kind: "session-ended" }); release();
	while (kinds.length < 2) await new Promise(r => setImmediate(r));
	assert.deepEqual(kinds, ["completion", "session-ended"]);
});

test("cached-binding resolution and shutdown reach Hub after producer origin lookup disconnects, without re-registration", async t => {
	const h = await setup(t); let disconnected = false; let registrations = 0;
	const client = createHubNotificationClient({ origin: async () => { if (disconnected) throw new Error("broker disconnected"); return h.origin; }, ensure: async () => h.endpoint, retryMs: 60000, rebindMs: 60000, report() {}, fetch: async (url, options) => { if (String(url).endsWith("register")) registrations++; return fetch(url, options); } });
	t.after(() => client.dispose());
	const noticeId = "owned";
	client.send({ version: 1, generation: h.origin.generation, eventId: randomUUID(), kind: "permission-requested", noticeId, cwd: "/work", title: "Preview" });
	while (!h.sent.length) await new Promise(r => setImmediate(r));
	await new Promise(r => setTimeout(r, 10)); const before = registrations; disconnected = true;
	client.send({ version: 1, generation: h.origin.generation, eventId: randomUUID(), kind: "permission-resolved", noticeId });
	while (h.visible.size) await new Promise(r => setImmediate(r));
	await new Promise(r => setTimeout(r, 10));
	client.send({ version: 1, generation: h.origin.generation, eventId: randomUUID(), kind: "session-ended" });
	await new Promise(r => setTimeout(r, 20)); await client.flush();
	assert.equal(registrations, before); assert.equal(h.visible.size, 0);
});
