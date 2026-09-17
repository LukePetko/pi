import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createNativePermissionSender } from "../extensions/lib/native-permission-notifications.ts";

async function waitFor(check) {
	for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); }
	assert.fail("Native sender did not settle");
}

async function fixture(t) {
	const records = await mkdtemp(join(tmpdir(), "pi-native-notice-"));
	t.after(() => rm(records, { recursive: true, force: true }));
	const app = { executable: "/test/Pi Permissions", records };
	const notice = { id: "live-request", title: "Push another repository", cwd: "/work/project", broker: {
		session: { id: "session", pid: process.pid }, requestId: "broker-request", directory: "/private/permissions",
	} };
	return { app, notice };
}

test("private record carries the live request, no credential or tool input, and is revoked before native removal", async (t) => {
	const { app, notice } = await fixture(t);
	const calls = [];
	let finishDelivery;
	let resolved = false;
	let remove;
	let delivered = 0;
	const sender = createNativePermissionSender({
		prepare: async () => app, birth: () => "birth",
		run: async (_app, operation, id) => {
			calls.push([operation, id]);
			if (operation === "show") return new Promise(resolve => { finishDelivery = resolve; });
			assert.equal((await readdir(app.records)).includes(`${id}.json`), false, "record must be revoked first");
			return "{}";
		},
		report: assert.fail,
	});
	remove = sender(notice, "legacy-group", () => { delivered++; if (resolved) remove(); });
	await waitFor(() => calls.length === 1);
	const id = calls[0][1];
	const file = join(app.records, `${id}.json`);
	const data = JSON.parse(await readFile(file, "utf8"));
	assert.equal(data.actionable, true);
	assert.deepEqual(data.broker, notice.broker);
	assert.equal(data.target.pid, process.pid);
	assert.equal(data.body, "project · Push another repository");
	assert.equal(data.callback.arguments.at(-1), file);
	assert.deepEqual(Object.keys(data).sort(), ["actionable", "body", "broker", "callback", "target", "title", "version"]);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	resolved = true; remove();
	await waitFor(() => calls.filter(([op]) => op === "remove").length === 1);
	finishDelivery("{}");
	await waitFor(() => delivered === 1 && calls.filter(([op]) => op === "remove").length === 2);
	assert.deepEqual(await readdir(app.records), []);
});

test("resolution during compilation cannot create a late alert", async (t) => {
	const { app, notice } = await fixture(t);
	let ready;
	let delivered = false;
	const operations = [];
	const sender = createNativePermissionSender({
		prepare: () => new Promise(resolve => { ready = resolve; }),
		run: async (_app, operation) => { operations.push(operation); return "{}"; }, report: assert.fail,
	});
	const remove = sender(notice, "group", () => { delivered = true; });
	remove(); ready(app);
	await waitFor(() => delivered);
	assert.equal(operations.includes("show"), false);
	assert.deepEqual(await readdir(app.records), []);
});

test("unavailable native notifications use the removable legacy fallback", async (t) => {
	const { notice } = await fixture(t);
	let fallback = 0, removed = 0, delivered = false;
	const sender = createNativePermissionSender({
		prepare: async () => { throw new Error("not authorized"); },
		fallback: (received, group) => {
			assert.equal(received, notice); assert.equal(group, "group"); fallback++;
			return () => { removed++; };
		}, report() {},
	});
	const remove = sender(notice, "group", () => { delivered = true; });
	await waitFor(() => delivered);
	assert.equal(fallback, 1);
	remove();
	assert.equal(removed, 1);
});

test("a missing broker produces Show-only native actions", async (t) => {
	const { app, notice } = await fixture(t);
	let done = false;
	const sender = createNativePermissionSender({
		prepare: async () => app, birth: () => "birth",
		run: async (_app, operation, id) => {
			if (operation === "show") {
				const data = JSON.parse(await readFile(join(app.records, `${id}.json`), "utf8"));
				assert.equal(data.actionable, false); assert.equal(data.broker, undefined);
			}
			return "{}";
		}, report: assert.fail,
	});
	const remove = sender({ id: notice.id, cwd: notice.cwd, title: notice.title }, "group", () => { done = true; });
	await waitFor(() => done); remove();
	await waitFor(async () => (await readdir(app.records)).length === 0);
});
