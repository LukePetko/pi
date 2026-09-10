import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = pathToFileURL(join(root, "agent/extensions/todos-web.ts")).href;
const cache = pathToFileURL(join(root, "agent/extensions/lib/hub-todos.ts")).href;

test("publisher replays sessions, consumes fresh tool snapshots, serializes writes, and cleans up", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "todos-web-load-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fixture = join(dir, "publisher.ts");
	writeFileSync(fixture, `
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import todosWeb from ${JSON.stringify(extension)};
import { readHubTodos } from ${JSON.stringify(cache)};
export default async function (pi) {
	const handlers = new Map();
	const directory = ${JSON.stringify(join(dir, "cache"))};
	todosWeb({ on: (event, handler) => handlers.set(event, handler) }, { directory, stableId: "" });
	let sessionId = "first";
	let branch = [];
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		ui: { notify() { throw new Error("unexpected publication failure"); } },
	};
	const identity = (id = sessionId) => ({ id, pid: process.pid, startedAt: Date.now() - 1000 });
	const read = (id = sessionId) => readHubTodos(directory, identity(id));
	const entry = (subject) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject, status: "pending" }], nextId: 2 } } });
	branch = [entry("Restored task")];
	await handlers.get("session_start")({}, ctx);
	assert.equal((await read()).current, "Restored task");
	const result = (subject) => ({ toolName: "todo", isError: false, result: { details: { tasks: [{ id: 1, subject, status: "in_progress" }], nextId: 2 } } });
	await handlers.get("tool_execution_end")(result("Fresh task"), ctx);
	assert.equal((await read()).current, "Fresh task", "tool event must not replay the stale branch");
	await handlers.get("tool_execution_end")({ ...result("Bad"), isError: true }, ctx);
	await handlers.get("tool_execution_end")({ ...result("Bad"), toolName: "other" }, ctx);
	assert.equal((await read()).current, "Fresh task");
	await Promise.all([
		handlers.get("tool_execution_end")(result("Earlier"), ctx),
		handlers.get("tool_execution_end")(result("Latest"), ctx),
	]);
	assert.equal((await read()).current, "Latest");
	sessionId = "second";
	branch = [entry("Other session")];
	await handlers.get("session_start")({}, ctx);
	assert.equal((await read()).current, "Other session");
	assert.equal((await read("first")).current, "Latest");
	branch = [entry("Compacted task")];
	await handlers.get("session_compact")({}, ctx);
	assert.equal((await read()).current, "Compacted task");
	branch = [];
	await handlers.get("session_tree")({}, ctx);
	assert.equal((await read()).total, 0);
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal(await read(), undefined);
	assert.equal((await read("first")).current, "Latest");
	sessionId = "first";
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal(await read(), undefined);

	const aliased = new Map();
	todosWeb({ on: (event, handler) => aliased.set(event, handler) }, { directory, stableId: "broker-alias" });
	branch = [entry("Alias task")];
	await aliased.get("session_start")({}, ctx);
	assert.equal((await read("broker-alias")).current, "Alias task");
	assert.equal(await read("first"), undefined);
	await aliased.get("session_shutdown")({}, ctx);

	const unavailable = join(${JSON.stringify(dir)}, "not-a-directory");
	await writeFile(unavailable, "file");
	const failing = new Map();
	let warnings = 0;
	todosWeb({ on: (event, handler) => failing.set(event, handler) }, { directory: unavailable, stableId: "" });
	const errorCtx = { ...ctx, ui: { notify: () => warnings++ } };
	await failing.get("session_start")({}, errorCtx);
	await failing.get("tool_execution_end")(result("Still unavailable"), errorCtx);
	assert.equal(warnings, 1, "cache failures are nonfatal and do not cause a toast storm");
	const disposed = new Map();
	todosWeb({ on: (event, handler) => disposed.set(event, handler) }, { directory: unavailable, stableId: "" });
	await assert.doesNotReject(() => disposed.get("session_start")({}, ctx), "a disposed notifier cannot break the agent");
	pi.registerCommand("todo-publisher-test-passed", { handler: async () => {} });
}
`);
	const result = spawnSync("pi", [
		"--offline", "--mode", "rpc", "--no-session", "--no-extensions",
		"--no-skills", "--no-prompt-templates", "--no-context-files", "-e", fixture,
	], { cwd: root, encoding: "utf8", input: '{"type":"get_commands","id":"publisher-test"}\n', timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
	const response = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === "publisher-test");
	assert.ok(response?.data?.commands.some((command) => command.name === "todo-publisher-test-passed"), result.stderr || result.stdout);
});
