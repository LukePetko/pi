import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createPermissionBroker, decidePermission, readPermissionSummaries } from "../extensions/lib/hub-permissions.ts";
import { createFocusNotifications } from "../extensions/lib/focus-notifications.ts";
import { createNativePermissionSender } from "../extensions/lib/native-permission-notifications.ts";
import { PERMISSION_REQUESTED, PERMISSION_RESOLVED, watchPermissionNotifications } from "../extensions/lib/permission-notifications.ts";

async function waitFor(check) {
	for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
	assert.fail("Notification lifecycle did not settle");
}

test("focusing Pi revokes its native notification but leaves the real permission request pending", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-focus-permission-"));
	const app = { executable: "/test/notifier", records: join(root, "records") };
	await mkdir(app.records);
	const directory = join(root, "broker");
	const broker = await createPermissionBroker(directory);
	const bus = new EventEmitter();
	let focused = false;
	const tracker = createFocusNotifications({ isFocused: async () => focused, intervalMs: 10 });
	const operations = [];
	const errors = [];
	const sender = createNativePermissionSender({
		prepare: async () => app, birth: () => "birth",
		run: async (_app, operation, id) => { operations.push([operation, id]); return "{}"; },
		report: error => { errors.push(error); },
	});
	const stop = watchPermissionNotifications({
		on(name, handler) { bus.on(name, handler); return () => { bus.off(name, handler); }; },
	}, (notice, group, onDelivered) => tracker.show(delivered => sender(notice, group, () => { delivered(); onDelivered(); })));
	t.after(async () => { stop(); tracker.dispose(); await broker.close(); await rm(root, { recursive: true, force: true }); });
	const session = { id: "focus-test", pid: process.pid };
	const decisions = [];
	const ticket = broker.request(session, { title: "Test permission", description: "Never automatically approve", cwd: root }, decision => {
		decisions.push(decision); bus.emit(PERMISSION_RESOLVED, { id: ticket.id });
	});
	await ticket.ready;
	bus.emit(PERMISSION_REQUESTED, { id: ticket.id, title: "Test permission", cwd: root, broker: { session, directory, requestId: ticket.id } });
	await waitFor(() => operations.some(([operation]) => operation === "show"));
	const id = operations.find(([operation]) => operation === "show")[1];
	focused = true;
	await waitFor(() => operations.some(([operation]) => operation === "remove"));
	await assert.rejects(readFile(join(app.records, `${id}.json`)), { code: "ENOENT" });
	assert.deepEqual(decisions, [], "focus must not decide anything");
	assert.equal((await readPermissionSummaries(session, directory))[0].id, ticket.id);
	assert.deepEqual(errors, []);
	await decidePermission(session, ticket.id, "once", directory);
	assert.deepEqual(decisions, ["once"], "explicit terminal/Hub approval still works after focus dismissal");
});

test("one focused session cannot dismiss another session's notifications", async (t) => {
	let focusedA = false;
	let removedA = 0, removedB = 0, sent = 0;
	const a = createFocusNotifications({ isFocused: async () => focusedA, intervalMs: 10 });
	const b = createFocusNotifications({ isFocused: async () => false, intervalMs: 10 });
	t.after(() => { a.dispose(); b.dispose(); });
	a.show(() => { sent++; return () => { removedA++; }; });
	b.show(() => { sent++; return () => { removedB++; }; });
	await waitFor(() => sent === 2);
	focusedA = true;
	await waitFor(() => removedA === 1);
	assert.equal(removedB, 0);
});
