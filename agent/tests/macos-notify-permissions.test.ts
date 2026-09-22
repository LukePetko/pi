import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import macosNotify from "../extensions/macos-notify.ts";
import { PERMISSION_REQUESTED, PERMISSION_RESOLVED } from "../extensions/lib/permission-notifications.ts";

function harness(channel?) {
	const handlers = new Map(); const commands = new Map(); const bus = new EventEmitter();
	const clients: any[] = [];
	if (channel) bus.on("intercom:extension-register", registration => registration.onReady(channel));
	macosNotify({
		on: (name, fn) => handlers.set(name, fn), registerCommand: (name, fn) => commands.set(name, fn),
		events: { emit: (name, data) => bus.emit(name, data), on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); } },
	} as any, {
		birth: () => "birth",
		client(options) { const events: any[] = []; const client = { send: e => events.push(e), flush: async () => {}, dispose() {} }; clients.push({ options, events }); return client; },
	});
	const ctx = { cwd: "/work/project", sessionManager: { getSessionId: () => "sdk-session" }, ui: { notify() {} } };
	return { handlers, commands, bus, clients, ctx };
}
test("macos-notify is event-only: permission resolution and agent_end are forwarded without OS execution", async () => {
	const h = harness();
	h.handlers.get("session_start")({}, h.ctx);
	h.bus.emit(PERMISSION_REQUESTED, { id: "permission-a", cwd: h.ctx.cwd, title: "Harmless preview" });
	h.bus.emit(PERMISSION_RESOLVED, { id: "permission-a" });
	h.handlers.get("agent_start")({}, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	await h.commands.get("notify-test").handler("", h.ctx);
	h.handlers.get("session_shutdown")();
	assert.deepEqual(h.clients[0].events.map(e => e.kind), ["permission-requested", "permission-resolved", "completion", "completion", "session-ended"]);
	assert.equal(new Set(h.clients[0].events.map(e => e.eventId)).size, 5);
	assert.equal(h.clients[0].events[3].test, true);
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 0);
});
test("macos-notify fences new SDK runtimes and excludes generic prompts", () => {
	const h = harness();
	h.handlers.get("session_start")({}, h.ctx);
	h.handlers.get("ui_prompt_start")?.({}, h.ctx);
	assert.equal(h.clients[0].events.length, 0);
	h.handlers.get("session_start")({}, h.ctx);
	h.handlers.get("agent_end")({}, h.ctx);
	assert.equal(h.clients[0].events[0].kind, "session-ended");
	assert.notEqual(h.clients[0].events[0].generation, h.clients[1].events[0].generation);
	h.handlers.get("session_shutdown")();
});
test("macos-notify forwards broker identity only, never executable/environment/broker paths", async (t) => {
	const old = process.env.PI_INTERCOM_SESSION_ID;
	process.env.PI_INTERCOM_SESSION_ID = "broker-id";
	t.after(() => { if (old === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = old; });
	const h = harness();
	h.handlers.get("session_start")({}, h.ctx);
	h.bus.emit(PERMISSION_REQUESTED, { id: "notice", cwd: h.ctx.cwd, title: "Preview", broker: { session: { id: "broker-id", pid: process.pid }, requestId: "request", directory: "/untrusted/path" } });
	assert.equal(h.clients[0].events[0].requestId, "request");
	assert.equal(JSON.stringify(h.clients[0].events).includes("untrusted"), false);
	h.bus.emit(PERMISSION_REQUESTED, { id: "wrong", cwd: h.ctx.cwd, title: "Preview", broker: { session: { id: "different", pid: process.pid }, requestId: "request", directory: "/untrusted/path" } });
	assert.equal(h.clients[0].events.length, 1);
	h.handlers.get("session_shutdown")();
});

test("quiet adapter rebind refreshes broker epoch without changing SDK runtime or publishing an event", async t => {
	const old = process.env.PI_INTERCOM_SESSION_ID;
	process.env.PI_INTERCOM_SESSION_ID = "broker-id";
	t.after(() => { if (old === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = old; });
	let epoch = "epoch-a";
	const h = harness({ snapshot: () => ({ connected: true }), listSessions: async () => [{ id: "broker-id", pid: process.pid, startedAt: 1, endpointEpoch: epoch }] });
	h.handlers.get("session_start")({}, h.ctx);
	const first = await h.clients[0].options.origin();
	epoch = "epoch-b";
	const second = await h.clients[0].options.origin();
	assert.equal(second.generation, first.generation); assert.equal(second.sequence, first.sequence);
	assert.equal(second.session, first.session); assert.equal(second.broker.endpointEpoch, "epoch-b");
	assert.ok(BigInt(second.bindingSequence) > BigInt(first.bindingSequence));
	assert.equal(first.broker.endpointEpoch, "epoch-a", "queued old snapshots cannot mutate into a new binding");
	assert.equal(h.clients[0].events.length, 0);
	h.handlers.get("session_shutdown")();
});

test("Intercom namespace registration is acknowledged once in either extension load ordering", () => {
	let registrations = 0;
	const channel = { snapshot: () => ({ connected: false }), listSessions: async () => [] };
	const late = harness();
	late.bus.on("intercom:extension-register", registration => {
		assert.equal(++registrations, 1, "registry rejects duplicate namespaces"); registration.onReady(channel);
	});
	late.bus.emit("intercom:extension-registry-ready"); late.handlers.get("session_start")({}, late.ctx);
	late.bus.emit("intercom:extension-registry-ready"); late.handlers.get("session_start")({}, late.ctx);
	assert.equal(registrations, 1); late.handlers.get("session_shutdown")();
	const early = harness(channel);
	early.bus.on("intercom:extension-register", () => assert.fail("factory already registered this namespace"));
	early.handlers.get("session_start")({}, early.ctx); early.bus.emit("intercom:extension-registry-ready");
	early.handlers.get("session_shutdown")();
});
