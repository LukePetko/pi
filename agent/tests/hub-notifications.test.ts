import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openHubNotifications, type HubNotice } from "../extensions/lib/hub-notifications.ts";
import { NotificationError, type NotificationOrigin, type NotificationEvent } from "../extensions/lib/hub-notification-protocol.ts";

const origin = (pid = 101, sequence = "1"): NotificationOrigin => ({ pid, birth: "birth", session: "sdk", generation: randomUUID(), sequence, bindingSequence: "1", broker: { id: `pi-${pid}`, startedAt: 1, endpointEpoch: "epoch-a" } });
const event = (o: NotificationOrigin, kind: NotificationEvent["kind"] = "completion", data = {}): NotificationEvent => ({ version: 1, eventId: randomUUID(), generation: o.generation, bindingSequence: o.bindingSequence, kind, cwd: "/work/project", ...data, ...("requestId" in data ? { noticeId: data.requestId } : {}) });
async function harness(t, extra = {}) {
	const directory = await mkdtemp("/tmp/pi-hub-notices-");
	const file = join(directory, "notifications.json");
	const visible = new Set<string>(); const sent: HubNotice[] = []; const removed: string[] = []; const decisions: any[] = [];
	let focused = false; let error: Error | undefined; let release: (() => void) | undefined;
	let wait = Promise.resolve();
	const options = { file, scope: directory, pollMs: 60000, report() {},
		sender: { async show(n, _o, live) { sent.push(n); await wait; visible.add(n.id); if (!live()) visible.delete(n.id); }, async remove(n) { removed.push(n.id); visible.delete(n.id); }, async list() { return [...visible]; } },
		authority: { async validate() { if (error) throw error; }, async focused() { return focused; }, async action(o, id, action) { if (error) throw error; decisions.push({ o, id, action }); } }, ...extra };
	let hub = await openHubNotifications(options); t.after(async () => { await hub.close(); await hub.drain(); await rm(directory, { recursive: true, force: true }); });
	return { file, sent, removed, visible, decisions, get hub() { return hub; },
		focus(value: boolean) { focused = value; }, fail(value?: Error) { error = value; },
		block() { wait = new Promise<void>(r => { release = r; }); }, release() { release?.(); },
		async restart() {
			await hub.drain(); const saved = await readFile(file); const ids = [...visible];
			await hub.close(); await hub.drain(); await writeFile(file, saved); ids.forEach(id => visible.add(id));
			hub = await openHubNotifications(options);
		},
		async ledger(): Promise<{ notices: HubNotice[]; runtimes: { origin: NotificationOrigin; ended: boolean; updated: number }[] }> { return JSON.parse(await readFile(file, "utf8")); },
	};
}
test("Hub accepts once before delivery, lost-response retries and restart do not replay; stored state cannot approve", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o);
	const e = event(o, "permission-requested", { noticeId: "notice", requestId: randomUUID(), title: "Preview" });
	await h.hub.event(e); await h.hub.drain(); await h.hub.event(e);
	assert.equal(h.sent.length, 1); const n = structuredClone(h.sent[0]);
	await h.restart();
	assert.equal(h.visible.has(n.id), true);
	await assert.rejects(h.hub.action({ id: n.id, capability: n.capability, action: "accept" }), /revoked/);
	await h.hub.register(o); await h.hub.event(e); await h.hub.drain();
	assert.equal(h.sent.length, 1);
	await h.hub.action({ id: n.id, capability: n.capability, action: "accept" });
	assert.equal(h.decisions[0].o.pid, o.pid); assert.equal(h.decisions[0].id, e.requestId);
	await assert.rejects(h.hub.action({ id: n.id, capability: n.capability, action: "accept" }));
});
test("Hub preserves already-delivered completions across restart, but never resurrects manually dismissed notices", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o);
	const a = event(o), b = event(o); await h.hub.event(a); await h.hub.event(b); await h.hub.drain();
	const ids = h.sent.map(n => n.id); h.visible.delete(ids[0]);
	await h.restart(); await h.hub.register(o); await h.hub.event(a); await h.hub.event(b); await h.hub.drain();
	assert.deepEqual([...h.visible], [ids[1]]); assert.equal(h.sent.length, 2);
	h.focus(true); await h.hub.poll(); assert.equal(h.visible.size, 0);
	await h.restart(); await h.hub.register(o); await h.hub.event(b); assert.equal(h.sent.length, 2);
});
test("resolution before request is a durable tombstone; late native add after resolution is removed without decision", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o);
	await h.hub.event(event(o, "permission-resolved", { noticeId: "early" }));
	await h.hub.event(event(o, "permission-requested", { noticeId: "early", title: "Preview" }));
	await h.hub.drain(); assert.equal(h.sent.length, 0);
	h.block(); await h.hub.event(event(o, "permission-requested", { noticeId: "late", title: "Preview" }));
	await new Promise(r => setImmediate(r));
	await h.hub.event(event(o, "permission-resolved", { noticeId: "late" }));
	h.release(); await h.hub.drain(); assert.equal(h.visible.size, 0); assert.equal(h.decisions.length, 0);
	await h.restart(); await h.hub.register(o);
	await h.hub.event(event(o, "permission-requested", { noticeId: "early", title: "Preview" })); assert.equal(h.sent.length, 1);
});
test("multiple Pi origins: focus, generation replacement and delayed shutdown only revoke owned notices", async t => {
	const h = await harness(t); const a = origin(101), b = origin(102);
	await h.hub.register(a); await h.hub.register(b); await h.hub.event(event(a)); await h.hub.event(event(b)); await h.hub.drain();
	const replacement = { ...a, sequence: "2", generation: randomUUID(), session: "new-sdk" };
	await h.hub.register(replacement); assert.equal(h.visible.size, 1); assert.equal(h.visible.has(h.sent[1].id), true);
	await assert.rejects(h.hub.register(a), /Stale/);
	await assert.rejects(h.hub.event(event(a, "session-ended")), /inactive/);
	await h.hub.event(event(replacement)); await h.hub.drain(); assert.equal(h.visible.size, 2);
	await h.hub.event(event(b, "session-ended")); assert.equal(h.visible.size, 1);
});
test("broker-only rebind preserves notice and runtime, fences delayed old binding/event and resumes exact live gate", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o);
	await h.hub.event(event(o, "permission-requested", { noticeId: "notice", requestId: randomUUID(), title: "Preview" })); await h.hub.drain();
	const n = structuredClone(h.sent[0]);
	h.fail(new NotificationError(425, "rebind")); await h.hub.poll(); assert.equal(h.visible.size, 1);
	await assert.rejects(h.hub.action({ id: n.id, capability: n.capability, action: "accept" }));
	h.fail(); const rebound = { ...o, bindingSequence: "2", broker: { ...o.broker!, endpointEpoch: "epoch-b" } };
	await h.hub.register(rebound);
	await assert.rejects(h.hub.register(o), /Stale/);
	await assert.rejects(h.hub.event(event(o)), /Stale/);
	await h.hub.action({ id: n.id, capability: n.capability, action: "show" });
	assert.equal(h.decisions[0].o.broker.endpointEpoch, "epoch-b"); assert.equal(h.sent.length, 1);
});
test("disconnection is unknown, dead/recycled origin is terminal, focus/stop never decide a permission", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o);
	h.focus(true); await h.hub.event(event(o)); await h.hub.drain(); assert.equal(h.sent.length, 0);
	h.focus(false); await h.hub.event(event(o)); await h.hub.drain();
	h.fail(new NotificationError(503, "disconnected")); await h.hub.poll(); assert.equal(h.visible.size, 1);
	h.fail(new NotificationError(409, "PID reused")); await h.hub.poll(); assert.equal(h.visible.size, 0);
	h.fail(); h.block(); await h.hub.event(event(o)); await new Promise(r => setImmediate(r));
	await h.hub.close(); h.release(); await h.hub.drain(); assert.equal(h.visible.size, 0); assert.equal(h.decisions.length, 0);
	await assert.rejects(h.hub.register(o), /stopped/);
});
test("ledger bounds reject rather than evict pending authority; producer executable/path fields and wrong SDK identity are rejected", async t => {
	const h = await harness(t, { limit: 2 }); const o = origin(); await h.hub.register(o);
	await assert.rejects(h.hub.register({ ...o, callback: { executable: "/tmp/bad" } }), /Invalid/);
	await assert.rejects(h.hub.register({ ...o, session: "wrong" }), /Stale/);
	await assert.rejects(h.hub.event({ ...event(o), directory: "/tmp/broker" }), /Invalid/);
	await h.hub.event(event(o)); await h.hub.event(event(o)); await h.hub.drain();
	await assert.rejects(h.hub.event(event(o)), /capacity/); assert.equal((await h.ledger()).notices.length, 2);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}
async function promptly<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Terminal operation blocked on external work")), 250); })]); }
	finally { clearTimeout(timer!); }
}
test("a held origin focus probe and slow OS removal cannot block another origin's end or durable service stop", async t => {
	const blocked = deferred(), entered = deferred(), removing = deferred();
	t.after(() => { blocked.resolve(); removing.resolve(); });
	let hold = false;
	const h = await harness(t, { authority: { async validate() {}, async focused(o) { if (hold && o.pid === 101) { entered.resolve(); await blocked.promise; } return false; }, async action() {} } });
	const a = origin(101), b = origin(102);
	await h.hub.register(a); await h.hub.register(b);
	await h.hub.event(event(a)); await h.hub.event(event(b)); await h.hub.drain();
	hold = true; const poll = h.hub.poll(); await entered.promise;
	await promptly(h.hub.event(event(b, "session-ended")));
	assert.equal((await h.ledger()).notices.find(n => n.generation === b.generation).state, "terminal");
	await promptly(h.hub.close());
	assert.ok((await h.ledger()).notices.every(n => n.state === "terminal" && n.capability === ""));
	blocked.resolve(); await poll;
	// Separate real removal barrier: no terminal state write waits for the OS.
	const revoked: string[] = [];
	const slow = await harness(t, { sender: { async show() {}, async list() { return []; }, async revoke(n: HubNotice) { revoked.push(n.id); }, async remove() { await removing.promise; } } });
	const c = origin(); await slow.hub.register(c);
	for (let i = 0; i < 6; i++) await slow.hub.event(event(c));
	await slow.hub.drain(); await promptly(slow.hub.close());
	assert.ok((await slow.ledger()).notices.every(n => n.state === "terminal"));
	assert.equal(new Set(revoked).size, 6, "record revocation is not queued behind the four slow OS removals");
	removing.resolve();
});
test("dead owner and obsolete broker binding can revoke only their exact stored notice without revalidating authority", async t => {
	const h = await harness(t); const a = origin(), b = origin(102);
	await h.hub.register(a); await h.hub.register(b);
	await h.hub.event(event(a, "permission-requested", { noticeId: "owned", title: "Preview" }));
	await h.hub.event(event(b, "permission-requested", { noticeId: "owned", title: "Other Pi" })); await h.hub.drain();
	await h.hub.register({ ...a, bindingSequence: "2", broker: { ...a.broker!, endpointEpoch: "new" } });
	h.fail(new NotificationError(409, "dead owner"));
	await promptly(h.hub.event(event(a, "permission-resolved", { noticeId: "owned" })));
	assert.equal((await h.ledger()).notices.find(n => n.generation === a.generation).state, "terminal");
	assert.equal((await h.ledger()).notices.find(n => n.generation === b.generation).state, "live");
	await promptly(h.hub.event(event(b, "session-ended"))); assert.equal(h.decisions.length, 0);
});
test("slow validation cannot publish after shutdown or restore an older runtime; action reservations are revoked while awaiting external work", async t => {
	const blocked = deferred(), entered = deferred(); t.after(blocked.resolve);
	let hold = false;
	const h = await harness(t, { authority: { async validate(o) { if (hold && o.sequence === "1") { entered.resolve(); await blocked.promise; } }, async focused() { return false; }, async action() {} } });
	const a = origin(); await h.hub.register(a); hold = true;
	const delayed = h.hub.event(event(a)); const delayedRegistration = h.hub.register(a);
	await entered.promise;
	const newer = { ...a, sequence: "2", generation: randomUUID() }; await promptly(h.hub.register(newer));
	await promptly(h.hub.close()); blocked.resolve();
	await assert.rejects(delayed, /inactive/); await assert.rejects(delayedRegistration, /stopped|Stale/);
	assert.equal(h.sent.length, 0);
	const gate = deferred(), acting = deferred(); t.after(gate.resolve); let decisions = 0;
	const other = await harness(t, { authority: { async validate() {}, async focused() { return false; }, async action(_o, _id, _action, current, signal) { acting.resolve(); await gate.promise; if (!current() || signal.aborted) throw new NotificationError(409, "revoked"); decisions++; } } });
	const o = origin(); await other.hub.register(o); await other.hub.event(event(o)); await other.hub.drain();
	const n = structuredClone(other.sent[0]); const action = other.hub.action({ id: n.id, capability: n.capability, action: "show" });
	await acting.promise; await promptly(other.hub.close()); gate.resolve();
	await assert.rejects(action, /revoked/); assert.equal(decisions, 0);
});
test("non-ASCII native capabilities are bounded authorization failures, not timingSafeEqual RangeErrors", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o); await h.hub.event(event(o)); await h.hub.drain();
	await assert.rejects(h.hub.action({ id: h.sent[0].id, capability: "é".repeat(64), action: "show" }), (error: any) => error.status === 403);
	assert.equal(h.decisions.length, 0);
});

test("a late terminal OS add from a crashed daemon is withdrawn during owned-ID reconciliation, never replayed", async t => {
	const h = await harness(t); const o = origin(); await h.hub.register(o); await h.hub.event(event(o)); await h.hub.drain();
	const id = h.sent[0].id; h.focus(true); await h.hub.poll(); await h.hub.drain();
	await h.restart();
	h.visible.add(id); // Old terminal-notifier child finished after revocation/restart.
	await h.hub.poll(); await h.hub.drain();
	assert.equal(h.visible.has(id), false); assert.equal(h.sent.length, 1); assert.equal(h.decisions.length, 0);
});

test("durable close seals old writer authority: late removal/poll and duplicate close cannot overwrite a replacement ledger", async t => {
	const directory = await mkdtemp("/tmp/pi-notice-handover-");
	const file = join(directory, "notifications.json");
	const removed = deferred(), listed = deferred(), listing = deferred();
	const visible = new Set<string>(); let holdList = false;
	const authority = { async validate() {}, async focused() { return false; }, async action() {} };
	const old = await openHubNotifications({ file, scope: directory, authority, pollMs: 60000, sender: {
		async show(n) { visible.add(n.id); }, async remove(n) { await removed.promise; visible.delete(n.id); },
		async list() { if (holdList) { listing.resolve(); await listed.promise; } return [...visible]; },
	} });
	let replacement: Awaited<ReturnType<typeof openHubNotifications>> | undefined;
	t.after(async () => { removed.resolve(); listed.resolve(); await old.close(); await old.drain(); await replacement?.close(); await replacement?.drain(); await rm(directory, { recursive: true, force: true }); });
	const o = origin(); await old.register(o); await old.event(event(o)); await old.drain();
	holdList = true; const poll = old.poll(); await listing.promise;
	const closing = old.close(); assert.equal(old.close(), closing, "duplicate close is the same durable operation");
	await promptly(closing);
	let drained = false; const draining = old.drain().then(() => { drained = true; });
	await new Promise(r => setImmediate(r)); assert.equal(drained, false, "main must retain its shutdown deadline while referenced workers remain");
	replacement = await openHubNotifications({ file, scope: directory, authority, pollMs: 60000, sender: {
		async show(n) { visible.add(n.id); }, async remove(n) { visible.delete(n.id); }, async list() { return [...visible]; },
	} });
	await replacement.register(o); const fresh = event(o); await replacement.event(fresh); await replacement.drain();
	const accepted = await readFile(file, "utf8");
	assert.ok(JSON.parse(accepted).notices.some((n: HubNotice) => n.event.eventId === fresh.eventId && n.state === "live"));
	removed.resolve(); listed.resolve(); await poll; await draining; await old.close();
	assert.equal(await readFile(file, "utf8"), accepted, "late old snapshots must never replace the new instance's accepted notice");
	assert.equal(drained, true);
});

test("zero-notice crashed runtimes retire durably, fence retries through retention/restart, then release capacity", async (t) => {
	let now = 1000;
	const dead = new Set<number>();
	const probes: number[] = [];
	const h = await harness(t, {
		limit: 2, now: () => now,
		authority: {
			async validate() {}, async focused() { return false; }, async action() {},
			async runtimeLiveness(o) { probes.push(o.pid); return dead.has(o.pid) ? "dead" : "live"; },
		},
	});
	const a = origin(101), b = origin(102), c = origin(103);
	await h.hub.register(a);
	await h.hub.register(b);
	// No shutdown event was recorded; restored disk-only runtimes must be probed too.
	await h.restart();
	dead.add(a.pid); dead.add(b.pid);
	now += 2 * 86400000;
	await h.hub.poll();
	assert.deepEqual(probes, [a.pid, b.pid]);
	assert.ok((await h.ledger()).runtimes.every((r) => r.ended && r.updated === now));
	await assert.rejects(h.hub.register(c), /capacity/);
	await h.restart();
	await assert.rejects(h.hub.register(a), /Stale/);
	await assert.rejects(h.hub.event(event(a)), /inactive/);
	now += 86400000 - 1;
	await h.hub.poll();
	await assert.rejects(h.hub.register(c), /capacity/);
	now += 2;
	await h.hub.poll();
	assert.equal((await h.ledger()).runtimes.length, 0);
	await h.restart();
	await h.hub.register(c);
	assert.deepEqual((await h.ledger()).runtimes.map((r) => r.origin.pid), [c.pid]);
});

test("runtime scans retain unknown/live actionable owners; resolved gates and generic 409s cannot retire runtimes", async (t) => {
	let now = 1000, failure: Error | undefined;
	const h = await harness(t, {
		now: () => now,
		authority: {
			async validate(_o, requestId) { if (failure && requestId) throw failure; },
			async focused() { return false; }, async action() {},
			async runtimeLiveness(o) {
				if (o.pid === 102) return "unknown";
				if (o.pid === 103) throw new NotificationError(409, "temporary probe failure");
				return "live";
			},
		},
	});
	const owners = [origin(101), origin(102), origin(103)];
	for (const o of owners) {
		await h.hub.register(o);
		await h.hub.event(event(o, "permission-requested", { requestId: randomUUID(), title: "Preview" }));
	}
	await h.hub.drain();
	now += 2 * 86400000;
	failure = new NotificationError(503, "Broker disconnected");
	await h.hub.poll();
	assert.ok((await h.ledger()).notices.every((n) => n.state === "live" && n.capability));
	failure = new NotificationError(409, "Gate resolved");
	await h.hub.poll();
	assert.ok((await h.ledger()).notices.every((n) => n.state === "terminal"));
	assert.equal((await h.ledger()).runtimes.length, 3);
	assert.ok((await h.ledger()).runtimes.every((r) => !r.ended));
	failure = undefined;
	await h.hub.event(event(owners[0]));
	await h.hub.drain();
	assert.equal((await h.ledger()).notices.at(-1)?.state, "live");
});

test("runtime probes are bounded/non-overlapping and progress independently of blocked notice enumeration", async (t) => {
	const listed = deferred(), listing = deferred(), probes = deferred(), entered = deferred();
	t.after(() => { listed.resolve(); probes.resolve(); });
	let holdList = false, holdProbes = false, active = 0, maximum = 0, calls = 0, dead = false;
	const h = await harness(t, {
		sender: {
			async show() {}, async remove() {},
			async list() { if (holdList) { listing.resolve(); await listed.promise; } return []; },
		},
		authority: {
			async validate() {}, async focused() { return false; }, async action() {},
			async runtimeLiveness() {
				calls++; active++; maximum = Math.max(maximum, active);
				if (active === 4) entered.resolve();
				if (holdProbes) await probes.promise;
				active--;
				return dead ? "dead" : "live";
			},
		},
	});
	const owners = Array.from({ length: 9 }, (_, i) => origin(101 + i));
	for (const o of owners) await h.hub.register(o);
	await h.hub.event(event(owners[0]));
	await h.hub.drain();
	holdList = true; holdProbes = true;
	const first = h.hub.poll();
	await Promise.all([listing.promise, entered.promise]);
	await promptly(h.hub.poll());
	assert.equal(calls, 4, "overlapping tick must not add probes");
	probes.resolve();
	while (calls < 9 || active) await new Promise((r) => setImmediate(r));
	// A live-only scan has no durable mutations; let its final transaction settle.
	await new Promise((r) => setImmediate(r));
	dead = true; holdProbes = false;
	await promptly(h.hub.poll());
	assert.equal(calls, 18);
	assert.equal(maximum, 4);
	assert.ok((await h.ledger()).runtimes.every((r) => r.ended));
	assert.ok((await h.ledger()).notices.every((n) => n.state === "terminal" && !n.capability));
	listed.resolve();
	await first;
});

for (const change of ["replacement", "rebind", "close"] as const) {
	test(`late runtime death result cannot retire ${change} identity or overwrite sealed close`, async (t) => {
		const entered = deferred(), blocked = deferred();
		t.after(blocked.resolve);
		let hold = true;
		const h = await harness(t, {
			authority: {
				async validate() {}, async focused() { return false; }, async action() {},
				async runtimeLiveness() { entered.resolve(); if (hold) await blocked.promise; return "dead"; },
			},
		});
		const o = origin();
		await h.hub.register(o);
		await h.hub.event(event(o, "permission-requested", { requestId: randomUUID(), title: "Preview" }));
		await h.hub.drain();
		const poll = h.hub.poll();
		await entered.promise;
		let next = o;
		if (change === "close") await promptly(h.hub.close());
		else {
			next = change === "replacement" ? { ...o, sequence: "2", generation: randomUUID() }
				: { ...o, bindingSequence: "2", broker: { ...o.broker!, endpointEpoch: "new" } };
			await promptly(h.hub.register(next));
			await assert.rejects(h.hub.register(o), /Stale/);
		}
		const saved = await readFile(h.file, "utf8");
		if (change === "close") await writeFile(h.file, "replacement daemon owns this file");
		hold = false; blocked.resolve();
		await poll;
		if (change === "close") {
			assert.equal(await readFile(h.file, "utf8"), "replacement daemon owns this file");
			await writeFile(h.file, saved);
		} else {
			assert.ok((await h.ledger()).runtimes.some((r) => r.origin.generation === next.generation && !r.ended));
			if (change === "rebind") assert.equal((await h.ledger()).notices[0].state, "live");
		}
	});
}

test("confirmed runtime death revokes an in-flight action and its capability without waiting for authority", async (t) => {
	const entered = deferred(), blocked = deferred();
	t.after(blocked.resolve);
	const h = await harness(t, {
		authority: {
			async validate() {}, async focused() { return false; },
			async runtimeLiveness() { return "dead"; },
			async action(_o, _id, _action, current, signal) {
				entered.resolve(); await blocked.promise;
				assert.equal(signal.aborted, true);
				assert.equal(current(), false);
				throw new NotificationError(409, "revoked");
			},
		},
	});
	const o = origin();
	await h.hub.register(o);
	await h.hub.event(event(o));
	await h.hub.drain();
	const n = structuredClone(h.sent[0]);
	const acting = h.hub.action({ id: n.id, capability: n.capability, action: "show" });
	await entered.promise;
	await promptly(h.hub.poll());
	assert.equal((await h.ledger()).runtimes[0].ended, true);
	assert.equal((await h.ledger()).notices[0].capability, "");
	blocked.resolve();
	await assert.rejects(acting, /revoked/);
});
