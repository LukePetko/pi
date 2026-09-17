import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
	PERMISSION_REQUESTED,
	PERMISSION_RESOLVED,
	watchPermissionNotifications,
} from "../extensions/lib/permission-notifications.ts";

function fixture() {
	const bus = new EventEmitter();
	const shown = [];
	const stop = watchPermissionNotifications({
		on(name, handler) {
			bus.on(name, handler);
			return () => { bus.off(name, handler); };
		},
	}, (notice, group, delivered) => {
		const record = { notice, group, delivered, removed: 0 };
		shown.push(record);
		return () => { record.removed++; };
	});
	const request = (id = "request-a") => bus.emit(PERMISSION_REQUESTED, {
		id, cwd: "/project", title: "Push another repository",
	});
	const resolve = (id = "request-a") => bus.emit(PERMISSION_RESOLVED, { id });
	return { bus, shown, stop, request, resolve };
}

test("one alert per live permission, with a group distinct from completion alerts", () => {
	const h = fixture();
	h.request(); h.request();
	assert.equal(h.shown.length, 1);
	assert.equal(h.shown[0].group, `pi-permission:${process.pid}:request-a`);
	assert.equal(h.shown[0].notice.title, "Push another repository");
	h.shown[0].delivered();
	assert.equal(h.shown[0].removed, 0, "delivery does not dismiss a waiting permission");
	h.resolve();
	assert.equal(h.shown[0].removed, 1);
	h.resolve();
	assert.equal(h.shown[0].removed, 1, "duplicate resolutions are harmless");
	h.stop();
});

test("approval racing notification delivery removes the late alert too", () => {
	const h = fixture();
	h.request();
	h.resolve();
	assert.equal(h.shown[0].removed, 1);
	h.shown[0].delivered();
	assert.equal(h.shown[0].removed, 2);
	h.stop();
});

test("independent requests do not clear each other", () => {
	const h = fixture();
	h.request("first"); h.request("second");
	assert.notEqual(h.shown[0].group, h.shown[1].group);
	h.resolve("first");
	assert.equal(h.shown[0].removed, 1);
	assert.equal(h.shown[1].removed, 0);
	h.stop();
	assert.equal(h.shown[1].removed, 1);
});

test("shutdown clears alerts, detaches listeners, and handles late delivery", () => {
	const h = fixture();
	h.request();
	h.stop(); h.stop();
	assert.equal(h.shown[0].removed, 1);
	assert.equal(h.bus.listenerCount(PERMISSION_REQUESTED), 0);
	assert.equal(h.bus.listenerCount(PERMISSION_RESOLVED), 0);
	h.shown[0].delivered();
	assert.equal(h.shown[0].removed, 2);
	h.request("new-session");
	assert.equal(h.shown.length, 1);
});

test("generic dialogs and malformed permission events never send alerts", () => {
	const h = fixture();
	h.bus.emit("ui_prompt_start", { kind: "select", title: "Choose a model" });
	for (const value of [null, "permission", {}, { id: "a" }, { id: 4, cwd: "/p", title: "t" }]) {
		h.bus.emit(PERMISSION_REQUESTED, value);
		h.bus.emit(PERMISSION_RESOLVED, value);
	}
	assert.equal(h.shown.length, 0);
	h.stop();
});

test("notification delivery and removal failures do not interrupt the caller", () => {
	const bus = new EventEmitter();
	const events = { on(name, handler) { bus.on(name, handler); return () => { bus.off(name, handler); }; } };
	let attempts = 0;
	const stop = watchPermissionNotifications(events, () => {
		if (++attempts === 1) throw new Error("notifier unavailable");
		return () => { throw new Error("removal unavailable"); };
	});
	const request = { id: "a", cwd: "/p", title: "permission" };
	assert.doesNotThrow(() => bus.emit(PERMISSION_REQUESTED, request));
	assert.doesNotThrow(() => bus.emit(PERMISSION_REQUESTED, request));
	assert.equal(attempts, 2, "failed delivery must not leave a stuck deduplication entry");
	assert.doesNotThrow(() => bus.emit(PERMISSION_RESOLVED, { id: "a" }));
	assert.doesNotThrow(stop);
});
