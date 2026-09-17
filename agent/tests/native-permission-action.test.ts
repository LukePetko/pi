import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createPermissionBroker, decidePermission, readPermissionSummaries } from "../extensions/lib/hub-permissions.ts";
import { performNativePermissionAction, processBirth, type NativePermissionRecord } from "../extensions/lib/native-permission-action.ts";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "pi-native-action-"));
	const broker = await createPermissionBroker(directory);
	t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
	const session = { id: "native-test", pid: process.pid };
	const decisions = [];
	const ticket = broker.request(session, { title: "Test permission", description: "secret command", cwd: directory }, decision => decisions.push(decision));
	await ticket.ready;
	const record: NativePermissionRecord = {
		version: 1, title: "Permission needed", body: "test", actionable: true,
		callback: { executable: "/usr/bin/true", arguments: [], environment: {} },
		target: { pid: process.pid, startedAt: processBirth(process.pid) },
		broker: { session, requestId: ticket.id, directory },
	};
	return { directory, broker, session, decisions, ticket, record };
}

test("Accept is one-time and a replay cannot change the decision", async (t) => {
	const h = await fixture(t);
	await performNativePermissionAction(h.record, "accept");
	assert.deepEqual(h.decisions, ["once"]);
	assert.deepEqual(await readPermissionSummaries(h.session, h.directory), []);
	await assert.rejects(performNativePermissionAction(h.record, "reject"), /no longer pending/);
	assert.deepEqual(h.decisions, ["once"]);
});

test("Reject uses the same live broker while Show only focuses Pi", async (t) => {
	const h = await fixture(t);
	const focused = [];
	await performNativePermissionAction(h.record, "show", {
		birth: processBirth, decide: decidePermission,
		focus: (pid) => { focused.push(pid); return { window: { id: "1", workspace: "1", appName: "test" } }; },
	});
	assert.deepEqual(focused, [process.pid]);
	assert.deepEqual(h.decisions, []);
	assert.equal((await readPermissionSummaries(h.session, h.directory)).length, 1);
	await performNativePermissionAction(h.record, "reject");
	assert.deepEqual(h.decisions, ["reject"]);
});

test("stale, mismatched, Show-only and persistent-approval actions are refused", async (t) => {
	const h = await fixture(t);
	await assert.rejects(performNativePermissionAction(h.record, "always"), /Unsupported/);
	await assert.rejects(performNativePermissionAction({ ...h.record, actionable: false }, "accept"), /requires a decision/);
	await assert.rejects(performNativePermissionAction({ ...h.record, target: { ...h.record.target, startedAt: "old process" } }, "accept"), /no longer alive/);
	await assert.rejects(performNativePermissionAction({ ...h.record, broker: { ...h.record.broker!, session: { id: "wrong", pid: process.pid + 1 } } }, "accept"), /requires a decision/);
	assert.deepEqual(h.decisions, []);
});

test("native callback CLI approves through the broker and fails closed after its record is revoked", async (t) => {
	const h = await fixture(t);
	const path = join(h.directory, "notice.json");
	await writeFile(path, JSON.stringify(h.record), { mode: 0o600 });
	const cli = fileURLToPath(new URL("../extensions/lib/native-permission-action.ts", import.meta.url));
	const exec = promisify(execFile);
	await exec(process.execPath, ["--experimental-strip-types", cli, path, "accept"]);
	assert.deepEqual(h.decisions, ["once"]);
	await rm(path);
	await assert.rejects(exec(process.execPath, ["--experimental-strip-types", cli, path, "accept"]));
	assert.deepEqual(h.decisions, ["once"]);
});
