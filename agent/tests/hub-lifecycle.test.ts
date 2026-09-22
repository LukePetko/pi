import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifecycle, readLifecycle, writeLifecycle, removeLifecycle } from "../extensions/lib/hub-lifecycle.ts";
import { attentionFields, classify } from "../extensions/lib/hub-attention.ts";
import { withHubTodos } from "../extensions/lib/hub-todo-source.ts";

const session = { id: "stable", pid: 42, startedAt: 1, endpointEpoch: "epoch-a", cwd: "/fixture", model: "test", lastActivity: 900, status: "idle" };
const message = (text = "Choose A", stopReason = "stop", errorMessage?: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }) as any;

test("real fresh idle is Parked; settled return uses real stamps, errors and bounded assistant text", () => {
	const state = createLifecycle(10);
	const view = (extra = {}) => ({ ...session, ...state.snapshot(), ...extra });
	assert.equal(classify(view(), {}).bucket, "PARKED");
	assert.equal(attentionFields(view(), {}).lastAgentEnd, null);
	assert.equal(classify(session, {}).bucket, "REVIEW", "old producers retain v1 fallback");
	state.user(20); state.start(21); state.end([message("x".repeat(900))], 30);
	assert.equal(classify(view(), {}).bucket, "WORKING", "intermediate agent_end is not a return even when Intercom is idle");
	assert.equal(state.snapshot().lastAgentEnd, null);
	state.start(40); state.end([message("old failure", "error"), message("Final answer")], 50); state.settled(51);
	assert.equal(state.snapshot().lastAgentEndError, false);
	assert.equal(state.snapshot().lastUserTurn, 20);
	assert.equal(state.snapshot().lastAgentEnd, 50);
	assert.equal(state.snapshot().enteredStateAt, 51);
	assert.equal(classify(view({ status: "thinking" }), {}).bucket, "REVIEW", "real returned beats lagging presence");
	assert.equal(classify(view({ lastActivity: 9999 }), { stable: 50 }).bucket, "PARKED");
	const todoView = view({ todos: { total: 2, completed: 1 } });
	assert.equal(classify(todoView, {}).reason, "question");
	assert.equal(attentionFields(todoView, {}).waitingSince, 51);
	for (const reason of ["error", "aborted"]) {
		state.start(60); state.end([message("", reason, "error text".repeat(100))], 70); state.settled(71);
		assert.equal(classify(view(), {}).reason, "error");
		assert.equal(state.snapshot().lastAssistantText.length, 600);
	}
});

test("nested prompts beat busy status and preserve waiting time through tools and settling", () => {
	const state = createLifecycle(10);
	state.start(20); state.promptStart(30); state.promptStart(31); state.statusChanged(32);
	assert.equal(state.snapshot().enteredStateAt, 30);
	assert.equal(classify({ ...session, status: "tool:bash · custom", ...state.snapshot() }, {}).reason, "prompt");
	state.promptEnd(40);
	assert.equal(state.snapshot().turnState, "prompt");
	state.end([message()], 45); state.settled(46);
	assert.equal(state.snapshot().enteredStateAt, 30);
	state.promptEnd(50);
	assert.equal(state.snapshot().turnState, "returned");
	assert.equal(state.snapshot().enteredStateAt, 50);
	state.promptEnd(51);
	assert.equal(state.snapshot().enteredStateAt, 50);
});

test("private bounded records require exact broker epochs; old writes/cleanup cannot affect replacement", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-lifecycle-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const old = createLifecycle(10).snapshot();
	await writeLifecycle(dir, session, old);
	assert.deepEqual(await readLifecycle(dir, session), old);
	assert.equal((await stat(dir)).mode & 0o777, 0o700);
	const file = join(dir, (await readdir(dir))[0]);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal(await readLifecycle(dir, { ...session, endpointEpoch: undefined }), undefined);
	const next = { ...session, endpointEpoch: "epoch-b" };
	assert.equal(await readLifecycle(dir, next), undefined, "same id/pid/start cannot reuse an old registration");
	const current = createLifecycle(20).snapshot();
	assert.notEqual(current.lifecycleGeneration, old.lifecycleGeneration);
	await writeLifecycle(dir, next, current);
	await writeLifecycle(dir, session, old);
	await removeLifecycle(dir, session);
	assert.deepEqual(await readLifecycle(dir, next), current);
	const nextFile = join(dir, (await readdir(dir))[0]);
	const valid = JSON.parse(await readFile(nextFile, "utf8"));
	for (const fields of [{ ...current, lastAssistantText: "x".repeat(601) }, { ...current, enteredStateAt: -1 }, { ...current, turnState: "idle" }]) {
		await writeFile(nextFile, JSON.stringify({ ...valid, fields }));
		assert.equal(await readLifecycle(dir, next), undefined);
	}
	await writeFile(nextFile, "x".repeat(8193));
	assert.equal(await readLifecycle(dir, next), undefined);
});

test("source replays after Hub restart and isolates same-id/pid registration replacement", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hub-lifecycle-source-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	let current = session;
	let connected = true;
	const listeners = new Set<() => void>();
	const source = { snapshot: () => ({ connected, sessions: connected ? [current] : [] }),
		subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, resolveSession: async () => current };
	const fields = createLifecycle(10).snapshot();
	await writeLifecycle(dir, current, fields);
	for (let restart = 0; restart < 2; restart++) {
		const enriched = withHubTodos(source, { directory: dir, lifecycleDirectory: dir });
		let stop = () => {};
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("No lifecycle replay")), 1900);
			stop = enriched.subscribe(() => { if (enriched.snapshot().sessions[0]?.turnState) { clearTimeout(timeout); resolve(); } });
		});
		assert.equal(classify(enriched.snapshot().sessions[0], {}).bucket, "PARKED");
		assert.equal((await enriched.resolveSession(current.id))?.lastAgentEnd, null);
		if (restart === 1) {
			current = { ...session, endpointEpoch: "epoch-b" };
			for (const listener of listeners) listener();
			assert.equal(enriched.snapshot().sessions[0].turnState, undefined, "never expose old metadata under replacement identity");
			assert.equal(enriched.snapshot().connected, false, "unhydrated replacement does not enable actions");
			connected = false;
			for (const listener of listeners) listener();
			assert.deepEqual(enriched.snapshot().sessions, []);
		}
		stop();
	}
});
