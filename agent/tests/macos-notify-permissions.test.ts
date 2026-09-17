import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
	PERMISSION_REQUESTED,
	PERMISSION_RESOLVED,
} from "../extensions/lib/permission-notifications.ts";

async function harness(t, customAppFails = false, isFocused = async () => false, sender?) {
	const calls = [];
	let shutdown = () => {};
	t.mock.method(fs, "existsSync", () => true);
	t.mock.method(fs, "readdirSync", () => []);
	t.mock.method(fs, "realpathSync", () => "/tmp/notifier.app/Contents/MacOS/terminal-notifier");
	t.mock.method(childProcess, "execFileSync", (command) => {
		if (customAppFails && command.endsWith("/lsregister")) throw new Error("registration failed");
		return command === "/bin/ps" ? "process birth stamp" : "";
	});
	t.mock.method(childProcess, "execFile", (command, args, callback) => {
		const call = { command, args, callback, stdinClosed: false };
		calls.push(call);
		return { stdin: { end() { call.stdinClosed = true; } } };
	});
	t.mock.method(console, "error", () => {});
	syncBuiltinESMExports();
	t.after(() => { shutdown(); t.mock.restoreAll(); syncBuiltinESMExports(); });
	const extension = await import(`../extensions/macos-notify.ts?permissions=${customAppFails}`);
	const bus = new EventEmitter();
	const handlers = new Map();
	const commands = new Map();
	extension.default({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		events: {
			on(name, handler) { bus.on(name, handler); return () => { bus.off(name, handler); }; },
		},
	}, sender ?? extension.legacyPermissionSender, isFocused);
	shutdown = () => handlers.get("session_shutdown")();
	assert.equal(calls.length, 0, "factory must not send notifications");
	handlers.get("session_start")();
	const request = async (id = "permission-a") => {
		bus.emit(PERMISSION_REQUESTED, {
			id,
			cwd: "/work/my-project",
			title: "Push another repository",
		});
		await setImmediate();
	};
	return { bus, calls, handlers, commands, request };
}

test("permission alerts use the persistent Pi sender and click action, then withdraw on resolution/shutdown", async (t) => {
	const h = await harness(t);
	await h.request();
	assert.equal(h.calls.length, 1);
	const sent = h.calls[0];
	const value = (flag) => sent.args[sent.args.indexOf(flag) + 1];
	assert.equal(value("-title"), "Permission needed");
	assert.equal(value("-message"), "my-project · Push another repository");
	assert.equal(value("-sender"), "works.earendil.pi-notifier.lukas");
	assert.match(value("-execute"), /focusPiSession/);
	assert.ok(sent.command.endsWith("/cache/Pi Notifier.app/Contents/MacOS/terminal-notifier"));
	assert.equal(sent.args.includes("-timeout"), false);
	const group = value("-group");
	h.bus.emit(PERMISSION_RESOLVED, { id: "permission-a" });
	assert.equal(h.calls[1].command, sent.command);
	assert.equal(h.calls[1].stdinClosed, true, "terminal-notifier -remove waits for stdin EOF");
	assert.deepEqual(h.calls[1].args, ["-remove", group, "-sender", "works.earendil.pi-notifier.lukas"]);
	sent.callback(null);
	assert.deepEqual(h.calls[2].args, h.calls[1].args, "late delivery must be removed too");
	await h.commands.get("notify-test").handler("", { cwd: "/work/my-project", ui: { notify() {} } });
	await setImmediate();
	const completionGroup = h.calls[3].args[h.calls[3].args.indexOf("-group") + 1];
	assert.match(completionGroup, /^pi-completion:/);
	assert.notEqual(completionGroup, group, "completion alerts remain independent");
	await h.request("permission-b");
	h.calls[4].callback(null);
	h.handlers.get("session_shutdown")();
	assert.equal(h.calls[5].args[0], "-remove");
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 0);
	h.handlers.get("session_start")();
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 1);
	h.handlers.get("session_shutdown")();
});

test("default-sender fallback remains removable and never creates unremovable AppleScript alerts", async (t) => {
	const h = await harness(t, true);
	await h.request();
	const sent = h.calls[0];
	assert.equal(sent.command, "terminal-notifier");
	assert.equal(sent.args.includes("-sender"), false);
	assert.ok(sent.args.includes("-execute"));
	sent.callback(new Error("delivery failed"));
	assert.equal(h.calls.length, 1, "permission delivery failure must not create a stale fallback alert");
	h.bus.emit(PERMISSION_RESOLVED, { id: "permission-a" });
	assert.equal(h.calls[1].command, "terminal-notifier");
	assert.equal(h.calls[1].args[0], "-remove");
	assert.equal(h.calls[1].args.includes("-sender"), false);
	await h.commands.get("notify-test").handler("", { cwd: "/work/my-project", ui: { notify() {} } });
	await setImmediate();
	h.calls[2].callback(new Error("completion delivery failed"));
	assert.equal(h.calls.length, 3, "completion failure must not create an unremovable fallback");
	h.handlers.get("session_shutdown")();
});

test("already-focused Pi suppresses permission and completion notifications without resolving permissions", async (t) => {
	const h = await harness(t, false, async () => true);
	let resolutions = 0;
	h.bus.on(PERMISSION_RESOLVED, () => { resolutions++; });
	await h.request();
	await h.commands.get("notify-test").handler("", { cwd: "/work/my-project", ui: { notify() {} } });
	await setImmediate();
	assert.equal(h.calls.length, 0);
	assert.equal(resolutions, 0);
});

test("focus clears native permission and uniquely grouped completion alerts without making a decision", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let focused = false;
	let removed = 0;
	let nativeDelivered;
	const sender = (_notice, _group, delivered) => {
		nativeDelivered = delivered;
		return () => { removed++; };
	};
	const h = await harness(t, false, async () => focused, sender);
	let resolutions = 0;
	h.bus.on(PERMISSION_RESOLVED, () => { resolutions++; });
	await h.request();
	for (let i = 0; i < 2; i++) {
		await h.handlers.get("agent_end")({}, { cwd: "/work/my-project" });
		await setImmediate();
	}
	const sent = [...h.calls];
	const groups = sent.map(call => call.args[call.args.indexOf("-group") + 1]);
	assert.equal(new Set(groups).size, 2, "completion groups must not remove other turns/sessions");
	focused = true;
	t.mock.timers.tick(1000); await setImmediate();
	assert.equal(removed, 1);
	assert.deepEqual(h.calls.slice(2).map(call => call.args.slice(0, 2)), groups.map(group => ["-remove", group]));
	assert.equal(resolutions, 0, "acknowledging notifications cannot approve or reject a request");
	nativeDelivered();
	assert.equal(removed, 2, "late native delivery is cleaned up too");
	sent[0].callback(null);
	assert.deepEqual(h.calls.at(-1).args.slice(0, 2), ["-remove", groups[0]]);
});
