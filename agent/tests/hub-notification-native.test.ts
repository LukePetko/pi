import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createHubNotificationSender } from "../extensions/lib/hub-notification-native.ts";
import type { HubNotice } from "../extensions/lib/hub-notifications.ts";

const notice = (owner: string): HubNotice => ({ key: randomUUID(), id: randomUUID(), owner, generation: randomUUID(), capability: "a".repeat(64), state: "live", updated: Date.now(), backend: "native", event: { version: 1, eventId: randomUUID(), generation: randomUUID(), kind: "permission-requested", noticeId: randomUUID(), cwd: "/work/project", title: "Harmless preview", requestId: randomUUID() } });
async function setup(t) {
	const root = await mkdtemp("/tmp/pi-native-hub-"); t.after(() => rm(root, { recursive: true, force: true }));
	const records = join(root, "requests"); await mkdir(records);
	return { root, app: { executable: "/trusted/not-executed", records } };
}
test("one canonical native record host routes two scopes with trusted callbacks and never removes another scope", async t => {
	const { root, app } = await setup(t); const calls: any[] = [];
	const options = { root, prepare: async () => app, run: async (_app, op, id) => { calls.push({ op, id }); return JSON.stringify({ delivered: [], pending: [] }); } };
	const a = createHubNotificationSender("/private/scope-a/endpoint.json", options), b = createHubNotificationSender("/private/scope-b/endpoint.json", options);
	const na = notice("scope-a"), nb = notice("scope-b");
	await a.show(na, {} as any, () => true, async () => false); await b.show(nb, {} as any, () => true, async () => false);
	const ra = JSON.parse(await readFile(join(app.records, `${na.id}.json`), "utf8"));
	assert.equal(ra.endpointFile, "/private/scope-a/endpoint.json"); assert.equal(ra.capability, na.capability);
	assert.ok(ra.callback.arguments.some(v => v.endsWith("hub-notification-action.ts")));
	assert.equal(ra.callback.environment.TMUX, undefined); assert.equal(ra.token, undefined); assert.equal(ra.broker, undefined);
	await assert.rejects(a.remove({ ...nb, owner: "scope-a" }), /another scope/);
	await a.remove(na); assert.equal(JSON.parse(await readFile(join(app.records, `${nb.id}.json`), "utf8")).owner, "scope-b");
	await b.remove(nb);
});
test("native prepare cancellation and uncertain add errors never use a second sender", async t => {
	const { root, app } = await setup(t); let unblock; let live = true; let sends = 0; let fallback = 0;
	const waiting = new Promise<any>(resolve => { unblock = resolve; });
	const sender = createHubNotificationSender("/private/endpoint.json", { root, prepare: () => waiting, run: async () => { sends++; return ""; } });
	const n = notice("scope"); const work = sender.show(n, {} as any, () => live, async () => { fallback++; return true; });
	live = false; unblock(app); await work; assert.equal(sends, 0); assert.equal(fallback, 0);
	const ambiguous = createHubNotificationSender("/private/endpoint.json", { root, prepare: async () => app, run: async (_app, op) => { if (op === "show") throw new Error("uncertain add"); return ""; } });
	await assert.rejects(ambiguous.show(n, {} as any, () => true, async () => { fallback++; return true; }), /uncertain/);
	assert.equal(fallback, 0); await ambiguous.remove(n);
});
test("prepare-only fallback is persisted show-only before terminal delivery and late delivery remains removable", async t => {
	const { root, app } = await setup(t); let delivered; let removed = 0; let live = true;
	t.mock.method(console, "error", () => {});
	const n = notice("scope");
	const sender = createHubNotificationSender("/private/endpoint.json", { root, prepare: async () => { throw new Error("no helper"); }, presentation: async () => ({ title: "Permission needed", executable: "/trusted/not-executed", sender: [] }), notify: (_title, _body, _icon, options) => { delivered = options.onDelivered; return () => { removed++; }; }, terminalRemove: async () => { removed++; } });
	const work = sender.show(n, {} as any, () => live, async () => { n.backend = "terminal"; n.showOnly = true; return true; });
	while (!delivered) await new Promise(r => setImmediate(r));
	assert.equal(JSON.parse(await readFile(join(app.records, `${n.id}.json`), "utf8")).actionable, false);
	live = false; await sender.remove(n); delivered(); await work;
	assert.ok(removed >= 2); await assert.rejects(readFile(join(app.records, `${n.id}.json`)));
});

test("cold presentation preparation is cancellable without delivering a late terminal alert", async t => {
	const { root } = await setup(t); let release!: (value: any) => void; let started = false; let live = true; let sent = 0;
	const pending = new Promise<any>(resolve => { release = resolve; });
	const n = { ...notice("scope"), backend: "terminal" as const };
	const sender = createHubNotificationSender("/private/endpoint.json", { root, presentation: async () => { started = true; return pending; }, notify: () => { sent++; return () => {}; }, terminalRemove: async () => {} });
	const work = sender.show(n, {} as any, () => live, async () => false);
	while (!started) await new Promise(r => setImmediate(r));
	live = false; await sender.remove(n);
	release({ title: "Complete", executable: "/trusted/not-executed", sender: [] }); await work;
	assert.equal(sent, 0);
});
