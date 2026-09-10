import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { projectHubTodos, readHubTodos, removeHubTodos, writeHubTodos } from "../extensions/lib/hub-todos.ts";
import { withHubTodos } from "../extensions/lib/hub-todo-source.ts";

const tasks = [
	{ id: 1, subject: "Set up", status: "completed", description: "PRIVATE DESCRIPTION" },
	{ id: 2, subject: "Build\nwidget", status: "in_progress", metadata: { secret: "PRIVATE METADATA" } },
	{ id: 3, subject: "Test", status: "pending" },
	{ id: 4, subject: "Deleted", status: "deleted" },
];
const session = { id: "../session/one", pid: 9876, startedAt: Date.now(), cwd: "/test", model: "test", lastActivity: Date.now() };
async function directory(t) {
	const dir = await mkdtemp(join(tmpdir(), "hub-todos-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function waitFor(predicate) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await delay(10);
	}
	assert.fail("Timed out waiting for todo snapshot");
}

test("projection limits published fields, removes deleted tasks, and bounds rows", () => {
	assert.deepEqual(projectHubTodos(tasks), {
		total: 3, completed: 1, current: "Build widget", tasks: [
			{ id: 1, subject: "Set up", status: "completed" },
			{ id: 2, subject: "Build widget", status: "in_progress" },
			{ id: 3, subject: "Test", status: "pending" },
		],
	});
	assert.equal(projectHubTodos(tasks.filter((task) => task.id !== 2)).current, "Test");
	assert.equal(projectHubTodos([tasks[0]]).current, "Set up");
	assert.deepEqual(projectHubTodos([null, {}, { id: 9, subject: "Bad", status: "bogus" }]), { total: 0, completed: 0, current: "", tasks: [] });
	const large = projectHubTodos(Array.from({ length: 300 }, (_, i) => ({ id: i + 1, subject: "界".repeat(1000), status: "pending" })));
	assert.equal(large.total, 300);
	assert.equal(large.tasks.length, 200);
	assert.equal(large.tasks[0].subject.length, 256);
});

test("cache is private, identity-bound, atomic, bounded, and removable", async (t) => {
	const dir = await directory(t);
	assert.equal(await readHubTodos(dir, session), undefined);
	await writeHubTodos(dir, session, tasks);
	const files = await readdir(dir);
	assert.equal(files.length, 1);
	assert.match(files[0], /^[a-f0-9]{64}\.json$/);
	const path = join(dir, files[0]);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	const raw = await readFile(path, "utf8");
	assert.doesNotMatch(raw, /PRIVATE/);
	assert.deepEqual(await readHubTodos(dir, session), projectHubTodos(tasks));
	assert.equal(await readHubTodos(dir, { ...session, pid: session.pid + 1 }), undefined);
	assert.equal(await readHubTodos(dir, { ...session, startedAt: Date.now() + 10_000 }), undefined);
	const data = JSON.parse(raw);
	data.todos.unrelated = "DO NOT SEND";
	data.todos.tasks[0].description = "DO NOT SEND";
	await writeFile(path, JSON.stringify(data));
	assert.doesNotMatch(JSON.stringify(await readHubTodos(dir, session)), /DO NOT SEND|description|unrelated/);
	await writeFile(path, "malformed");
	assert.equal(await readHubTodos(dir, session), undefined);
	await writeFile(path, " ".repeat(300_000));
	assert.equal(await readHubTodos(dir, session), undefined);
	await writeHubTodos(dir, session, tasks);
	await removeHubTodos(dir, { ...session, pid: session.pid + 1 });
	assert.ok(await readHubTodos(dir, session), "another process cannot delete this session's snapshot");
	await writeHubTodos(dir, session, []);
	assert.equal((await readHubTodos(dir, session)).total, 0);
	await removeHubTodos(dir, session);
	assert.equal(await readHubTodos(dir, session), undefined);
	assert.deepEqual(await readdir(dir), []);
});

test("source streams cached task changes without presence events and drops departed identities", async (t) => {
	const dir = await directory(t);
	let state = { connected: true, sessions: [session] };
	const listeners = new Set<() => void>();
	const source = withHubTodos({
		snapshot: () => state,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		resolveSession: async (id) => state.sessions.find((item) => item.id === id),
	}, { directory: dir, pollMs: 10 });
	let updates = 0;
	const unsubscribe = source.subscribe(() => updates++);
	t.after(unsubscribe);
	await writeHubTodos(dir, session, tasks);
	await waitFor(() => source.snapshot().sessions[0]?.todos?.total === 3);
	assert.equal(await source.resolveSession(session.id), session);
	await writeHubTodos(dir, session, [{ id: 5, subject: "New task", status: "in_progress" }]);
	await waitFor(() => source.snapshot().sessions[0]?.todos?.current === "New task");
	const unchangedUpdates = updates;
	await delay(50);
	assert.equal(updates, unchangedUpdates, "unchanged polls do not generate SSE floods");
	state = { connected: true, sessions: [{ ...session, pid: session.pid + 1 }] };
	for (const listener of listeners) listener();
	assert.equal(source.snapshot().sessions[0].todos, undefined, "same ID with a new process never sees old tasks");
	state = { connected: false, sessions: [] };
	for (const listener of listeners) listener();
	assert.deepEqual(source.snapshot(), state);
	unsubscribe();
	assert.equal(listeners.size, 0);
	const stoppedUpdates = updates;
	await delay(30);
	assert.equal(updates, stoppedUpdates, "unsubscribe stops polling and callbacks");
});
