import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createFocusNotifications } from "../extensions/lib/focus-notifications.ts";
import { ensureClickableNotifierApp, findNotifierApp } from "../extensions/lib/macos-notify-click.ts";
import { ensureNativePermissionApp, runNativePermissionApp } from "../extensions/lib/native-permission-app.ts";
import { createNativePermissionSender } from "../extensions/lib/native-permission-notifications.ts";

const enabled = process.platform === "darwin" && process.env.PI_NATIVE_NOTIFICATION_TEST === "1";

function execute(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(stdout));
		child.stdin?.end();
	});
}

async function waitFor(check) {
	for (let i = 0; i < 50; i++) { if (await check()) return; await delay(100); }
	assert.fail("macOS focus cleanup did not settle");
}

test("a focus transition removes a real completion alert from macOS", { skip: !enabled }, async (t) => {
	const agent = join(homedir(), ".pi", "agent");
	const executable = ensureClickableNotifierApp({
		sourceApp: findNotifierApp(), app: join(agent, "cache", "Pi Notifier.app"),
		icon: join(agent, "Pi Notifier.app", "Contents", "Resources", "AppIcon.icns"),
		bundleId: "works.earendil.pi-notifier.lukas",
	});
	const sender = ["-sender", "works.earendil.pi-notifier.lukas"];
	const group = `pi-focus-smoke-${randomUUID()}`;
	let focused = false;
	const errors = [];
	const tracker = createFocusNotifications({ isFocused: async () => focused, intervalMs: 50 });
	t.after(async () => { tracker.dispose(); await execute(executable, ["-remove", group, ...sender]); });
	tracker.show(delivered => {
		void execute(executable, ["-title", "Pi focus cleanup test", "-message", "Testing dismissal; no action needed.", "-group", group, ...sender])
			.catch(error => { errors.push(error); }).finally(delivered);
		return () => { void execute(executable, ["-remove", group, ...sender]).catch(error => { errors.push(error); }); };
	});
	await waitFor(async () => (await execute(executable, ["-list", group, ...sender])).includes(group));
	focused = true;
	await waitFor(async () => !(await execute(executable, ["-list", group, ...sender])).includes(group));
	assert.deepEqual(errors, []);
});

test("a focus transition revokes and removes a real native permission alert", { skip: !enabled }, async (t) => {
	const app = await ensureNativePermissionApp();
	const settings = JSON.parse(await runNativePermissionApp(app, "status"));
	if (![2, 3].includes(settings.authorization)) { t.skip("Allow Pi Permissions notifications first"); return; }
	let focused = false;
	let id: string | undefined;
	const errors = [];
	const tracker = createFocusNotifications({ isFocused: async () => focused, intervalMs: 50 });
	const sender = createNativePermissionSender({
		prepare: async () => app,
		run: (app, operation, requestId) => {
			if (operation === "show") id = requestId;
			return runNativePermissionApp(app, operation, requestId);
		},
		report: error => { errors.push(error); },
	});
	t.after(async () => { tracker.dispose(); if (id) await runNativePermissionApp(app, "remove", id); });
	tracker.show(delivered => sender({ id: randomUUID(), title: "Focus cleanup test; no approval needed", cwd: "/notification-test" }, "test", delivered));
	await waitFor(async () => id && JSON.parse(await runNativePermissionApp(app, "list")).delivered.includes(id));
	focused = true;
	await waitFor(async () => {
		const state = JSON.parse(await runNativePermissionApp(app, "list"));
		return !state.delivered.includes(id) && !state.pending.includes(id);
	});
	assert.ok(id);
	await assert.rejects(readFile(join(app.records, `${id}.json`)), { code: "ENOENT" });
	assert.deepEqual(errors, []);
});
