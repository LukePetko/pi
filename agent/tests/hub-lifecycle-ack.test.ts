import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifecycle } from "../extensions/lib/hub-lifecycle.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";

test("ack uses real completion and rejects stale generation, prompt, provisional end and fresh idle", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-lifecycle-ack-"));
	const state = createLifecycle(10);
	const base = { id: "stable", pid: 42, startedAt: 1, endpointEpoch: "a", cwd: "/fixture", model: "test", lastActivity: 900, status: "idle" };
	let session = { ...base, ...state.snapshot() };
	let fresh = session;
	const token = "f".repeat(64);
	const stateFile = join(dir, "state.json");
	const hub = await startHubServer({ token, stateFile, focus: async () => {}, source: {
		snapshot: () => ({ connected: true, sessions: [session] }), subscribe: () => () => {}, resolveSession: async () => fresh,
	} });
	t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
	const ack = (body: Record<string, unknown> = {}) => fetch(`${hub.origin}/api/ack`, { method: "POST", headers: {
		Authorization: `Bearer ${token}`, Origin: hub.origin, "Content-Type": "application/json",
	}, body: JSON.stringify({ id: "stable", ...body }) });
	assert.equal((await ack()).status, 409);
	state.start(20); state.end([], 30);
	fresh = session = { ...base, ...state.snapshot() };
	assert.equal((await ack()).status, 409);
	state.settled(31);
	fresh = session = { ...base, ...state.snapshot() };
	assert.equal((await ack({ lastAgentEnd: 900 })).status, 409);
	assert.equal((await ack({ lifecycleGeneration: "old-runtime", lastAgentEnd: 30 })).status, 409);
	fresh = { ...session, endpointEpoch: "replacement" };
	assert.equal((await ack()).status, 409);
	fresh = { ...session, turnState: "prompt" };
	assert.equal((await ack()).status, 409);
	fresh = { ...session, lastAgentEnd: 40 };
	assert.equal((await ack()).status, 409, "fresh lifecycle read cannot acknowledge a newer cached completion");
	fresh = session;
	const accepted = await ack({ lifecycleGeneration: session.lifecycleGeneration, lastAgentEnd: 30 });
	assert.equal(accepted.status, 200);
	assert.equal((await accepted.json()).snapshot.sessions[0].bucket, "PARKED");
	assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).acks, { stable: 30 });
});

test("ack response cannot replace newer real lifecycle with a higher presence timestamp", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-lifecycle-ack-race-"));
	const state = createLifecycle(1);
	state.start(2); state.end([], 10); state.settled(11);
	const cached = { id: "stable", pid: 42, startedAt: 1, endpointEpoch: "a", cwd: "/fixture", model: "test", lastActivity: 50, status: "idle", ...state.snapshot() };
	const fresh = { ...cached, lastActivity: 100 };
	state.start(101);
	const newer = { ...cached, ...state.snapshot() };
	let reads = 0;
	let observedNewState = false;
	const token = "f".repeat(64);
	const hub = await startHubServer({ token, stateFile: join(dir, "state.json"), focus: async () => {}, source: {
		snapshot: () => {
			if (reads) reads++;
			observedNewState ||= reads >= 3;
			return { connected: true, sessions: [reads >= 3 ? newer : cached] };
		}, subscribe: () => () => {}, resolveSession: async () => { reads = 1; return fresh; },
	} });
	t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
	const response = await fetch(`${hub.origin}/api/ack`, { method: "POST", headers: {
		Authorization: `Bearer ${token}`, Origin: hub.origin, "Content-Type": "application/json",
	}, body: JSON.stringify({ id: "stable", lastAgentEnd: 10 }) });
	assert.equal(response.status, 200);
	assert.equal(observedNewState, true);
	const value = (await response.json()).snapshot.sessions[0];
	assert.equal(value.turnState, "running");
	assert.equal(value.enteredStateAt, 101);
	assert.equal(value.bucket, "WORKING");
	assert.equal(value.lastActivity, 50, "presence-only freshness must not roll lifecycle back");
});
