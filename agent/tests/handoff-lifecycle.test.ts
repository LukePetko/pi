import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import handoff from "../extensions/handoff.ts";
import { lifecycleDirectory, readLifecycle } from "../extensions/lib/hub-lifecycle.ts";
const INTERCOM_EXTENSION_REGISTER_EVENT = "intercom:extension-register";
const INTERCOM_EXTENSION_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

test("producer publishes fresh idle, handles late registry, replays broker reconnect and rotates on reload", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-producer-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousId = process.env.PI_INTERCOM_SESSION_ID;
	process.env.PI_CODING_AGENT_DIR = dir;
	process.env.PI_INTERCOM_SESSION_ID = "stable";
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		if (previousId === undefined) delete process.env.PI_INTERCOM_SESSION_ID; else process.env.PI_INTERCOM_SESSION_ID = previousId;
		await rm(dir, { recursive: true, force: true });
	});
	let own = { id: "stable", pid: process.pid, startedAt: 1, endpointEpoch: "first" };
	let connected = true;
	let listSessions = async () => [own];
	function runtime(registryFirst: boolean) {
		const bus = new EventEmitter();
		const handlers = new Map<string, Function>();
		let registration;
		let ready: Promise<void> | undefined;
		const installRegistry = () => bus.on(INTERCOM_EXTENSION_REGISTER_EVENT, (value) => {
			assert.equal(registration, undefined, "register once despite registry-ready replay");
			registration = value;
			ready = value.onReady({ snapshot: () => ({ connected, supported: true }), listSessions: () => listSessions() });
		});
		if (registryFirst) installRegistry();
		handoff({ on: (name, fn) => handlers.set(name, fn), events: {
			emit: (name, payload) => bus.emit(name, payload), on: (name, fn) => { bus.on(name, fn); return () => bus.off(name, fn); },
		} } as any);
		const ctx = { sessionManager: { getSessionId: () => "pi-session-id" } };
		return { handlers, bus, installRegistry, ctx, get registration() { return registration; }, get ready() { return ready; } };
	}
	const first = runtime(false);
	await first.handlers.get("session_start")!({}, first.ctx);
	assert.equal(await readLifecycle(lifecycleDirectory(), own), undefined);
	first.installRegistry();
	first.bus.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
	await first.ready;
	first.bus.emit(INTERCOM_EXTENSION_REGISTRY_READY_EVENT, { version: 1 });
	const fresh = await readLifecycle(lifecycleDirectory(), own);
	assert.equal(fresh?.turnState, "returned");
	assert.equal(fresh?.lastAgentEnd, null, "published before any prompt/turn");
	await first.handlers.get("message_start")!({ message: { role: "user" } });
	await first.handlers.get("agent_start")!();
	await first.handlers.get("agent_end")!({ messages: [{ role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop" }] });
	assert.equal((await readLifecycle(lifecycleDirectory(), own))?.turnState, "running");
	await first.handlers.get("agent_settled")!();
	const returned = await readLifecycle(lifecycleDirectory(), own);
	assert.ok(returned?.lastUserTurn);
	assert.ok(returned?.lastAgentEnd);
	connected = false;
	await first.registration.onEvent({ type: "connection", connected: false });
	own = { ...own, endpointEpoch: "reconnected" };
	connected = true;
	await first.registration.onEvent({ type: "connection", connected: true });
	assert.deepEqual(await readLifecycle(lifecycleDirectory(), own), returned, "reconnect preserves all timestamps and generation");
	// A late list result cannot publish into a replacement runtime/registration.
	let release;
	listSessions = () => new Promise((resolve) => { release = resolve; });
	const late = first.registration.onEvent({ type: "connection", connected: true });
	const shutdown = first.handlers.get("session_shutdown")!();
	own = { ...own, endpointEpoch: "reloaded" };
	listSessions = async () => [own];
	const second = runtime(true);
	await second.handlers.get("session_start")!({}, second.ctx);
	const reloaded = await readLifecycle(lifecycleDirectory(), own);
	assert.equal(reloaded?.lastAgentEnd, null);
	assert.notEqual(reloaded?.lifecycleGeneration, returned?.lifecycleGeneration);
	release([own]);
	await late; await shutdown;
	assert.deepEqual(await readLifecycle(lifecycleDirectory(), own), reloaded);
	await second.handlers.get("ui_prompt_start")!();
	assert.equal((await readLifecycle(lifecycleDirectory(), own))?.turnState, "prompt");
	await second.handlers.get("session_shutdown")!();
	assert.equal(await readLifecycle(lifecycleDirectory(), own), undefined);
});
