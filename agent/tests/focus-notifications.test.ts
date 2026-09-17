import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { createFocusNotifications } from "../extensions/lib/focus-notifications.ts";

function fixture(t) {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let focused = false;
	let probes = 0;
	const notices = [];
	const errors = [];
	const watcher = createFocusNotifications({
		isFocused: async () => { probes++; return focused; },
		onError: error => { errors.push(error); },
	});
	t.after(() => watcher.dispose());
	function show() {
		const notice = { removed: 0, delivered: () => {} };
		const cancel = watcher.show(delivered => {
			notice.delivered = delivered;
			notices.push(notice);
			return () => { notice.removed++; };
		});
		return { notice, cancel };
	}
	return {
		watcher, notices, errors, show, probes: () => probes,
		focus(value: boolean) { focused = value; },
		async tick() { t.mock.timers.tick(1000); await setImmediate(); },
	};
}

test("idle sessions do not poll; already-focused sessions never send a notification", async (t) => {
	const h = fixture(t);
	await h.tick();
	assert.equal(h.probes(), 0);
	h.focus(true); h.show();
	await setImmediate();
	assert.equal(h.notices.length, 0);
	const probes = h.probes();
	await h.tick();
	assert.equal(h.probes(), probes, "suppression stops the watcher");
});

test("returning to a session clears all its outstanding alerts and stops polling", async (t) => {
	const h = fixture(t);
	h.show(); h.show();
	await setImmediate();
	assert.equal(h.notices.length, 2);
	assert.equal(h.probes(), 1, "concurrent notifications share their initial probe");
	await h.tick();
	assert.deepEqual(h.notices.map(n => n.removed), [0, 0]);
	h.focus(true); await h.tick();
	assert.deepEqual(h.notices.map(n => n.removed), [1, 1]);
	const probes = h.probes(); await h.tick();
	assert.equal(h.probes(), probes);
});

test("late delivery after focus is removed again rather than leaving a stale alert", async (t) => {
	const h = fixture(t);
	const { notice } = h.show();
	await setImmediate(); h.focus(true); await h.tick();
	assert.equal(notice.removed, 1);
	notice.delivered();
	assert.equal(notice.removed, 2);
});

test("cancellation while probing suppresses delivery; slow probes never overlap", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let resolve;
	let probes = 0, sends = 0;
	const watcher = createFocusNotifications({ isFocused: () => {
		probes++; return new Promise<boolean>(done => { resolve = done; });
	} });
	t.after(() => watcher.dispose());
	const cancel = watcher.show(() => { sends++; return () => {}; });
	await setImmediate();
	t.mock.timers.tick(5000); await setImmediate();
	assert.equal(probes, 1);
	cancel(); resolve(false); await setImmediate();
	assert.equal(sends, 0);
});

test("shutdown removes alerts, cancels probes and prevents further sends", async (t) => {
	const h = fixture(t);
	const { notice } = h.show(); await setImmediate();
	h.watcher.dispose(); h.watcher.dispose(); h.show();
	assert.equal(notice.removed, 1);
	const probes = h.probes(); await h.tick();
	assert.equal(h.probes(), probes);
	assert.equal(h.notices.length, 1);
	notice.delivered(); assert.equal(notice.removed, 2);
});

test("focus detection errors keep notifications visible", async (t) => {
	let sent = 0, removed = 0;
	const watcher = createFocusNotifications({ isFocused: async () => { throw new Error("probe failed"); } });
	t.after(() => watcher.dispose());
	watcher.show(() => { sent++; return () => { removed++; }; });
	await setImmediate();
	assert.equal(sent, 1); assert.equal(removed, 0);
});

test("notification failures cannot stop cleanup of other notifications", async (t) => {
	const h = fixture(t);
	h.watcher.show(() => { throw new Error("send failed"); });
	h.watcher.show(() => () => { throw new Error("remove failed"); });
	const { notice } = h.show(); await setImmediate();
	h.focus(true); await h.tick();
	assert.equal(notice.removed, 1);
	assert.equal(h.errors.length, 2);
});
