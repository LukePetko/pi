import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionBroker, inspectPermission, decidePermission, readPermissionSummaries } from "../extensions/lib/hub-permissions.ts";

const session = { id: "session", pid: process.pid, startedAt: Date.now() - 1000 };
const details = { title: "Echo preview", cwd: "/project", description: '$ echo "hello"', toolName: "bash", input: '{"command":"echo hello","secret":"PRIVATE INPUT"}' };
async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "hub-permissions-"));
	const broker = await createPermissionBroker(directory);
	t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
	return { directory, broker };
}

test("full requests stay in owner memory; remote/local decisions are once-only and expire", async (t) => {
	const { directory, broker } = await fixture(t);
	const decisions = [];
	const ticket = broker.request(session, details, (decision) => decisions.push(decision));
	await ticket.ready;
	assert.deepEqual(await readPermissionSummaries(session, directory), [{ id: ticket.id, title: details.title }]);
	const file = join(directory, (await readdir(directory))[0]);
	assert.doesNotMatch(await readFile(file, "utf8"), /PRIVATE INPUT|echo hello/);
	assert.deepEqual((await inspectPermission(session, ticket.id, directory)).input, details.input);
	await assert.rejects(inspectPermission({ ...session, id: "other" }, ticket.id, directory), { status: 409 });
	await assert.rejects(inspectPermission({ ...session, pid: process.pid + 1 }, ticket.id, directory), { status: 409 });
	await decidePermission(session, ticket.id, "once", directory);
	ticket.decide("reject");
	assert.deepEqual(decisions, ["once"]);
	await assert.rejects(decidePermission(session, ticket.id, "once", directory), { status: 409 });
	assert.deepEqual(await readPermissionSummaries(session, directory), []);
	const local = broker.request(session, details, (decision) => decisions.push(decision));
	await local.ready;
	local.decide("reject");
	await assert.rejects(inspectPermission(session, local.id, directory), { status: 409 });
	const cancelled = broker.request(session, details, (decision) => decisions.push(decision));
	await cancelled.ready;
	cancelled.cancel();
	await assert.rejects(decidePermission(session, cancelled.id, "once", directory), { status: 409 });
	assert.deepEqual(decisions, ["once", "reject"]);
});

test("private bridge rejects unauthenticated, cross-origin, persistent, and oversized approvals", async (t) => {
	const { directory, broker } = await fixture(t);
	const decisions = [];
	const ticket = broker.request(session, details, (decision) => decisions.push(decision));
	await ticket.ready;
	const manifest = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"));
	const post = (body, headers = {}) => fetch(`${manifest.origin}/decision`, {
		method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
	});
	const body = { id: session.id, requestId: ticket.id, decision: "once" };
	assert.equal((await post(body)).status, 403);
	assert.equal((await post(body, { Authorization: `Bearer ${manifest.token}`, Origin: manifest.origin })).status, 403);
	assert.equal((await post({ ...body, decision: "always" }, { Authorization: `Bearer ${manifest.token}` })).status, 400);
	assert.deepEqual(decisions, []);
	const huge = broker.request(session, { ...details, input: "x".repeat(1024 * 1024) }, (decision) => decisions.push(decision));
	await huge.ready;
	await assert.rejects(inspectPermission(session, huge.id, directory), { status: 413 });
	await assert.rejects(decidePermission(session, huge.id, "once", directory), { status: 413 });
	assert.deepEqual(decisions, []);
	huge.decide("once"); // Explicit native approval is still possible.
	assert.deepEqual(decisions, ["once"]);
	await broker.close();
	assert.deepEqual(decisions, ["once", "reject"]);
	assert.deepEqual(await readPermissionSummaries(session, directory), []);
});

test("old broker shutdown cannot delete a replacement broker's request", async (t) => {
	const { directory, broker } = await fixture(t);
	const old = broker.request(session, details, () => {});
	await old.ready;
	const replacement = await createPermissionBroker(directory);
	t.after(() => replacement.close());
	const fresh = replacement.request(session, details, () => {});
	await fresh.ready;
	await broker.close();
	assert.deepEqual(await readPermissionSummaries(session, directory), [{ id: fresh.id, title: details.title }]);
	await assert.rejects(inspectPermission(session, old.id, directory), { status: 409 });
});
