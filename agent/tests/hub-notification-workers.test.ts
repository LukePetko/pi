import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";

test("terminal list/remove close stdin; cold presentation and origin focus use bounded asynchronous workers", async t => {
	const calls: any[] = [];
	t.mock.method(childProcess, "execFileSync", () => { assert.fail("No synchronous OS command belongs in the resident event loop"); });
	t.mock.method(childProcess, "execFile", (executable, args, options, callback) => {
		const call = { executable, args, options, ended: false }; calls.push(call);
		const result = args.includes("--prepare") ? JSON.stringify({ title: "Complete", executable: "/trusted/notifier", sender: [] }) : "listed";
		// Simulate terminal-notifier's no-message read-to-EOF behavior.
		return { stdin: { end() { call.ended = true; queueMicrotask(() => callback(null, result, "")); } } };
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const { runTerminalNotification } = await import("../extensions/lib/hub-notification-native.ts");
	assert.equal(await runTerminalNotification("/trusted/notifier", ["-list", "ALL"]), "listed");
	assert.equal(await runTerminalNotification("/trusted/notifier", ["-remove", randomUUID()]), "listed");
	assert.ok(calls.slice(0, 2).every(call => call.ended && call.options.timeout === 10000));
	const { prepareNotificationPresentation } = await import("../extensions/lib/hub-notification-presentation.ts");
	assert.equal((await prepareNotificationPresentation(true)).title, "Complete");
	const preparation = calls.at(-1); assert.ok(preparation.args.includes("--prepare")); assert.equal(preparation.options.timeout, 60000); assert.equal(preparation.options.killSignal, "SIGKILL");
	const { focusNotificationOrigin } = await import("../extensions/lib/hub-notification-focus.ts");
	const origin = { pid: 9876, birth: "birth", session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1", tmuxSocket: "/private/origin.sock" };
	const controller = new AbortController(); await focusNotificationOrigin(origin, controller.signal);
	const focus = calls.at(-1); assert.deepEqual(JSON.parse(focus.args.at(-1)), origin);
	assert.equal(focus.options.signal, controller.signal); assert.equal(focus.options.timeout, 10000); assert.equal(focus.options.killSignal, "SIGKILL");
	assert.ok(focus.executable.startsWith("/")); assert.deepEqual(focus.options.env, { PATH: "/usr/bin:/bin" });
});
