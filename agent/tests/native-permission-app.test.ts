import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ensureNativePermissionApp, runNativePermissionApp } from "../extensions/lib/native-permission-app.ts";

const enabled = process.platform === "darwin" && process.env.PI_NATIVE_NOTIFICATION_TEST === "1";

test("compiled native helper registers safe actions and rejects invalid identifiers", { skip: !enabled }, async () => {
	const app = await ensureNativePermissionApp();
	assert.deepEqual(JSON.parse(await runNativePermissionApp(app, "self-test")), {
		actions: ["accept", "reject", "show"], authenticationRequired: true,
	});
	await assert.rejects(runNativePermissionApp(app, "show", "../other-request"));
	await assert.rejects(runNativePermissionApp(app, "remove", "not-a-request"));
});

test("real macOS delivery and removal are request-specific and leave no pending alert", { skip: !enabled }, async (t) => {
	const app = await ensureNativePermissionApp();
	const settings = JSON.parse(await runNativePermissionApp(app, "status"));
	if (![2, 3].includes(settings.authorization)) {
		t.skip("Allow Pi Permissions notifications in macOS first");
		return;
	}
	const ids = [randomUUID(), randomUUID()];
	t.after(async () => {
		for (const id of ids) {
			await unlink(join(app.records, `${id}.json`)).catch(() => {});
			await runNativePermissionApp(app, "remove", id);
		}
	});
	for (const id of ids) {
		await writeFile(join(app.records, `${id}.json`), JSON.stringify({
			title: "Pi native notification test", body: "Testing cleanup. No permission will be granted.", actionable: true,
			callback: { executable: "/usr/bin/true", arguments: [], environment: {} },
		}), { mode: 0o600, flag: "wx" });
		await runNativePermissionApp(app, "show", id);
	}
	let state;
	for (let i = 0; i < 30; i++) {
		state = JSON.parse(await runNativePermissionApp(app, "list"));
		if (ids.every(id => state.delivered.includes(id))) break;
		await delay(100);
	}
	assert.ok(ids.every(id => state.delivered.includes(id)), "native delivery never became visible to Notification Center");
	await unlink(join(app.records, `${ids[0]}.json`));
	await runNativePermissionApp(app, "remove", ids[0]);
	state = JSON.parse(await runNativePermissionApp(app, "list"));
	assert.equal(state.delivered.includes(ids[0]), false);
	assert.equal(state.pending.includes(ids[0]), false);
	assert.equal(state.delivered.includes(ids[1]), true, "removal must not clear other requests");
});
