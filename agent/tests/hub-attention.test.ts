import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attentionFields, classify, openAcknowledgements } from "../extensions/lib/hub-attention.ts";
import { describePermission } from "../extensions/lib/hub-permissions.ts";

const session = { id: "s", name: "Named", cwd: "/work/project", model: "test", pid: 2, startedAt: 1, lastActivity: 20, status: "idle" };
const todos = { total: 2, completed: 1, current: "Pick a design", tasks: [] };

test("Phase 1 classifies permission > working > open todos > review > acknowledged parked", () => {
	assert.deepEqual(classify({ ...session, status: "tool:bash", permissions: [{ id: "p", title: "Ask" }] }, {}), { bucket: "NEEDS_YOU", reason: "permission" });
	for (const status of ["thinking", "thinking · custom", "tool:read"]) assert.equal(classify({ ...session, status, todos }, {}).bucket, "WORKING");
	assert.deepEqual(classify({ ...session, todos }, {}), { bucket: "NEEDS_YOU", reason: "question" });
	assert.deepEqual(classify(session, {}), { bucket: "REVIEW", reason: "done" });
	assert.equal(classify({ ...session, todos }, { s: 20 }).bucket, "PARKED");
	assert.equal(classify(session, { s: 19 }).bucket, "REVIEW");
	assert.equal(classify({ ...session, status: "unknown" }, {}).bucket, "PARKED");
	assert.equal(classify({ ...session, status: "idle · custom" }, {}).bucket, "REVIEW");
	assert.equal(classify({ ...session, id: "constructor" }, {}).bucket, "REVIEW");
});

test("display names and approximate waiting timestamps use existing data only", () => {
	assert.equal(attentionFields(session, {}).displayName, "Named");
	assert.equal(attentionFields({ ...session, runtimeFallbackAlias: true, todos }, {}).displayName, "Pick a design");
	assert.equal(attentionFields({ ...session, runtimeFallbackAlias: true }, {}).displayName, "project");
	assert.equal(attentionFields({ ...session, todos }, {}).waitingSince, 20);
	assert.equal(attentionFields(session, {}).lastAgentEnd, 20);
	assert.equal(attentionFields(session, {}).waitingSince, null);
});

test("acknowledgements survive reload, serialize writes, preserve future fields and use private files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-acks-")); t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "session.json");
	await writeFile(file, JSON.stringify({ cap: 4, acks: { previous: 1 } }));
	const acks = await openAcknowledgements(file);
	await Promise.all([acks.set("a", 20), acks.set("b", 30), acks.set("__proto__", 40)]);
	await assert.rejects(acks.set("bad", NaN), /Invalid acknowledgement/);
	await assert.rejects(acks.set("bad", -1), /Invalid acknowledgement/);
	assert.equal((await openAcknowledgements(file)).get().a, 20);
	const saved = JSON.parse(await readFile(file, "utf8"));
	assert.equal(saved.cap, 4); assert.equal(saved.acks.previous, 1); assert.equal(saved.acks.b, 30);
	assert.equal(Object.hasOwn(saved.acks, "__proto__"), true);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await writeFile(file, "broken json");
	await assert.rejects(openAcknowledgements(file), /Invalid Hub/);
	await assert.rejects(acks.set("c", 50), /Invalid Hub/);
	assert.equal(acks.get().c, undefined);
	assert.equal(await readFile(file, "utf8"), "broken json");
	await writeFile(file, JSON.stringify({ acks: {}, oversized: "x".repeat(1024 * 1024) }));
	await assert.rejects(openAcknowledgements(file), /too large/);
});

test("display-only risk inference recognizes specified high-risk operations without deciding gates", () => {
	const request = (tool: string, input: { path?: string; command?: string }) => ({ id: "p", title: "Gate", cwd: "/work/project", description: "Gate details", createdAt: 1, toolName: tool, input: JSON.stringify(input) });
	for (const command of ["rm -rf folder", "git push", "git -C elsewhere push", "git reset --hard", "sudo ls", "curl example.org", "wget example.org", "npm publish", "docker ps", "ssh host", "scp a host:b"]) {
		assert.equal(describePermission(request("bash", { command })).risk, "high", command);
	}
	for (const path of ["../outside", ".env.local", join(homedir(), ".ssh/config"), join(homedir(), ".pi/agent/settings.json")]) {
		assert.equal(describePermission(request("write", { path })).risk, "high", path);
	}
	assert.equal(describePermission(request("bash", { command: "pnpm test" })).risk, "low");
	assert.equal(describePermission(request("write", { path: "src/file.ts" })).risk, "low");
	assert.equal(describePermission({ ...request("bash", {}), input: "invalid" }).risk, "high");
	assert.ok(describePermission(request("bash", { command: "x".repeat(1000) })).summary.length <= 240);
	assert.equal(describePermission(request("bash", { command: "git reset ".repeat(1000) })).risk, "high", "very long shell text is conservatively high rather than exhaustively pattern-matched");
});
