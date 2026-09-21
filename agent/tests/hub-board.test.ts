import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECKIN_MS, CheckinBoard, compareSessions, changedSessions } from "../extensions/lib/pi-hub-web/board.ts";
import type { HubSession } from "../extensions/lib/pi-hub-web-server.ts";

const session = (id: string, bucket: HubSession["bucket"], at: number): HubSession => ({
	id, name: id, cwd: "/p", model: "test", pid: 123, startedAt: 1000 - at, lastActivity: at,
	bucket, lastAgentEnd: at, enteredStateAt: at, status: "idle", permissions: [],
});

test("bucket ordering uses risk/wait, return/activity timestamps and deterministic ID ties", () => {
	const values = [session("parked", "PARKED", 80), session("work-old", "WORKING", 30), session("review-old", "REVIEW", 10),
		session("review-new", "REVIEW", 50), session("work-new", "WORKING", 60), session("need-new", "NEEDS_YOU", 40),
		session("need-old", "NEEDS_YOU", 20), { ...session("high", "NEEDS_YOU", 90), risk: "high" as const }];
	assert.deepEqual(values.sort(compareSessions).map(s => s.id), ["high", "need-old", "need-new", "review-new", "review-old", "work-new", "work-old", "parked"]);
});

test("default freeze bootstraps once, retains unrelated changes, and admits only new high-risk gates", () => {
	const board = new CheckinBoard(0);
	board.receive({ connected: false, sessions: [] }, 1);
	const a = session("a", "WORKING", 1), b = session("b", "REVIEW", 2);
	board.receive({ connected: true, sessions: [a, b] }, 2);
	const aDone = { ...a, bucket: "REVIEW" as const, lastAgentEnd: 3 };
	board.receive({ connected: true, sessions: [aDone, b] }, 3);
	assert.equal(board.displayed.sessions[0], a);
	const low = { ...b, bucket: "NEEDS_YOU" as const, risk: "low" as const, permissions: [{ id: "low", title: "Write", risk: "low" as const }] };
	board.receive({ connected: true, sessions: [aDone, low] }, 4);
	assert.equal(board.displayed.sessions[1], b);
	const high = { ...low, risk: "high" as const, permissions: [{ id: "high", title: "Push", risk: "high" as const }] };
	board.receive({ connected: true, sessions: [aDone, high] }, 5);
	assert.equal(board.displayed.sessions[0], a, "high risk must not flush unrelated pending work");
	assert.equal(board.displayed.sessions[1], high);
	assert.equal(changedSessions(board.displayed, board.pending), 1);
	assert.equal(board.tick(CHECKIN_MS - 1), false);
	assert.equal(board.tick(CHECKIN_MS), true);
	assert.equal(board.displayed.sessions[0], aDone);
	assert.equal(board.nextCheckin, CHECKIN_MS * 2);
});

test("manual check-ins, Live toggle and cadence use independent clocks", () => {
	const board = new CheckinBoard(100);
	board.receive({ connected: true, sessions: [session("a", "REVIEW", 1)] }, 200);
	board.receive({ connected: true, sessions: [] }, 300);
	board.apply(400); assert.equal(board.displayed.sessions.length, 0);
	assert.equal(board.nextCheckin, 100 + CHECKIN_MS);
	board.setLive(true, 500);
	board.receive({ connected: true, sessions: [session("b", "WORKING", 2)] }, 600);
	assert.equal(board.displayed.sessions[0].id, "b");
	board.setLive(false);
	board.receive({ connected: true, sessions: [] }, 700);
	assert.equal(board.displayed.sessions.length, 1);
	assert.equal(changedSessions(board.displayed, board.pending), 1);
});
