import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import {
	PERMISSION_REQUESTED,
	PERMISSION_RESOLVED,
} from "../extensions/lib/permission-notifications.ts";

async function harness(t, customAppFails = false) {
	const calls = [];
	t.mock.method(fs, "existsSync", () => true);
	t.mock.method(fs, "readdirSync", () => []);
	t.mock.method(fs, "realpathSync", () => "/tmp/notifier.app/Contents/MacOS/terminal-notifier");
	t.mock.method(childProcess, "execFileSync", (command) => {
		if (customAppFails && command.endsWith("/lsregister")) throw new Error("registration failed");
		return command === "/bin/ps" ? "process birth stamp" : "";
	});
	t.mock.method(childProcess, "execFile", (command, args, callback) => {
		calls.push({ command, args, callback });
		return {};
	});
	t.mock.method(console, "error", () => {});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
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
	});
	assert.equal(calls.length, 0, "factory must not send notifications");
	handlers.get("session_start")();
	const request = (id = "permission-a") => bus.emit(PERMISSION_REQUESTED, {
		id, cwd: "/work/my-project", title: "Push another repository",
	});
	return { bus, calls, handlers, commands, request };
}

test("permission alerts use the persistent Pi sender and click action, then withdraw on resolution/shutdown", async (t) => {
	const h = await harness(t);
	h.request();
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
	assert.deepEqual(h.calls[1].args, ["-remove", group, "-sender", "works.earendil.pi-notifier.lukas"]);
	sent.callback(null);
	assert.deepEqual(h.calls[2].args, h.calls[1].args, "late delivery must be removed too");
	await h.commands.get("notify-test").handler("", { cwd: "/work/my-project", ui: { notify() {} } });
	assert.equal(h.calls[3].args.includes("-group"), false, "completion alerts remain independent");
	h.request("permission-b");
	h.calls[4].callback(null);
	h.handlers.get("session_shutdown")();
	assert.equal(h.calls[5].args[0], "-remove");
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 0);
	h.handlers.get("session_start")();
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 1);
	h.handlers.get("session_shutdown")();
});

test("default-sender fallback remains removable and permissions never use non-removable AppleScript alerts", async (t) => {
	const h = await harness(t, true);
	h.request();
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
	h.calls[2].callback(new Error("completion delivery failed"));
	assert.equal(h.calls[3].command, "osascript", "completion fallback is preserved");
	h.handlers.get("session_shutdown")();
});
