import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import configRevision from "../extensions/config-revision.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const result = (head) => ({ stdout: `${head}\n`, stderr: "", code: 0, killed: false });

function harness(t, mode = "tui") {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const handlers = new Map();
	const widgets = new Map();
	const calls = [];
	let response = result(A);
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/some/unrelated/project",
		ui: {
			theme: { fg: (color, text) => `${color}: ${text}` },
			setWidget: (key, value) => widgets.set(key, value),
		},
	};
	function install() {
		configRevision({
			on: (event, handler) => { handlers.set(event, handler); },
			exec: async (...args) => {
				calls.push(args);
				if (response instanceof Error) throw response;
				return response;
			},
		} as Parameters<typeof configRevision>[0]);
	}
	install();
	const emit = (event, reason) => handlers.get(event)({ reason }, ctx);
	t.after(() => emit("session_shutdown", "quit"));
	return {
		calls,
		widgets,
		install,
		emit,
		respond: (value) => { response = value; },
		async tick(ms = 30_000) {
			t.mock.timers.tick(ms);
			await setImmediate();
		},
	};
}

function widget(h) {
	return h.widgets.get("config-revision");
}

test("starts only with a TUI session and polls ~/.pi every 30 seconds", async (t) => {
	const h = harness(t);
	await h.tick();
	assert.equal(h.calls.length, 0, "factory must not start resources");
	await h.emit("session_start", "startup");
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0].slice(0, 2), [
		"git", ["-C", join(homedir(), ".pi"), "rev-parse", "--verify", "HEAD"],
	]);
	assert.equal(h.calls[0][2].timeout, 5_000);
	assert.ok(h.calls[0][2].signal instanceof AbortSignal);
	await h.tick(29_999);
	assert.equal(h.calls.length, 1);
	await h.tick(1);
	assert.equal(h.calls.length, 2);
	assert.equal(widget(h), undefined);
});

test("latches a warning after a commit change and stops unnecessary polling", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	h.respond(result(B));
	await h.tick();
	assert.deepEqual(widget(h), ["warning: ↻ Config updated · /reload"]);
	h.respond(result(A));
	await h.tick(90_000);
	assert.equal(h.calls.length, 2);
	assert.deepEqual(widget(h), ["warning: ↻ Config updated · /reload"]);
});

test("reload clears the warning and establishes the new runtime baseline", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	h.respond(result(B));
	await h.tick();
	await h.emit("session_shutdown", "reload");
	assert.equal(widget(h), undefined);
	h.install();
	await h.emit("session_start", "reload");
	await h.tick();
	assert.equal(widget(h), undefined);
	h.respond(result(A));
	await h.tick();
	assert.match(widget(h)[0], /Config updated/);
});

test("shutdown is idempotent, aborts Git, and clears the timer and widget", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	const signal = h.calls[0][2].signal;
	await h.emit("session_shutdown", "quit");
	await h.emit("session_shutdown", "quit");
	await h.tick(90_000);
	assert.equal(signal.aborted, true);
	assert.equal(h.calls.length, 1);
	assert.equal(widget(h), undefined);
});

test("repeated starts do not accumulate timers", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	const signal = h.calls[0][2].signal;
	await h.emit("session_start", "reload");
	assert.equal(signal.aborted, true);
	await h.tick();
	assert.equal(h.calls.length, 3);
});

test("a slow poll cannot overlap or write to a replacement runtime", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	let resolve;
	h.respond(new Promise((done) => { resolve = done; }));
	await h.tick();
	await h.tick(90_000);
	assert.equal(h.calls.length, 2);
	const signal = h.calls[1][2].signal;
	await h.emit("session_shutdown", "reload");
	h.respond(result(B));
	h.install();
	await h.emit("session_start", "reload");
	resolve(result(B));
	await setImmediate();
	assert.equal(signal.aborted, true);
	assert.equal(widget(h), undefined);
	await h.tick();
	assert.equal(h.calls.length, 4);
	assert.equal(widget(h), undefined);
});

test("shutdown during the initial Git read cannot create a late timer", async (t) => {
	const h = harness(t);
	let resolve;
	h.respond(new Promise((done) => { resolve = done; }));
	const starting = h.emit("session_start", "startup");
	await h.emit("session_shutdown", "quit");
	resolve(result(A));
	await starting;
	await h.tick();
	assert.equal(h.calls.length, 1);
	assert.equal(widget(h), undefined);
});

test("transient Git failures preserve the baseline and retry", async (t) => {
	const h = harness(t);
	await h.emit("session_start", "startup");
	for (const failure of [
		new Error("git missing"),
		{ ...result(B), code: 128 },
		{ ...result(B), killed: true },
		result(""),
		result("HEAD"),
	]) {
		h.respond(failure);
		await h.tick();
		assert.equal(widget(h), undefined);
	}
	h.respond(result(B));
	await h.tick();
	assert.match(widget(h)[0], /Config updated/);
});

test("an unavailable initial revision is reported, never adopted later as loaded", async (t) => {
	const h = harness(t);
	h.respond(new Error("not a git repository"));
	await h.emit("session_start", "startup");
	assert.deepEqual(widget(h), ["warning: ↻ Config revision unknown · /reload"]);
	h.respond(result(B));
	await h.tick();
	assert.equal(h.calls.length, 1);
	await h.emit("session_shutdown", "reload");
	h.install();
	await h.emit("session_start", "reload");
	assert.equal(widget(h), undefined);
});

test("accepts SHA-256 Git revisions", async (t) => {
	const h = harness(t);
	h.respond(result("a".repeat(64)));
	await h.emit("session_start", "startup");
	assert.equal(widget(h), undefined);
	h.respond(result("b".repeat(64)));
	await h.tick();
	assert.match(widget(h)[0], /Config updated/);
});

for (const mode of ["rpc", "json", "print"]) {
	test(`does not poll or modify UI in ${mode} mode`, async (t) => {
		const h = harness(t, mode);
		await h.emit("session_start", "startup");
		await h.tick();
		await h.emit("session_shutdown", "quit");
		assert.equal(h.calls.length, 0);
		assert.equal(h.widgets.size, 0);
	});
}
