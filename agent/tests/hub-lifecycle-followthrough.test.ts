import assert from "node:assert/strict";
import { test } from "node:test";
import { CheckinBoard } from "../extensions/lib/pi-hub-web/board.ts";
import type { HubSession } from "../extensions/lib/pi-hub-web-server.ts";

const prompt: HubSession = { id: "acted", pid: 42, startedAt: 1, endpointEpoch: "epoch", lifecycleGeneration: "generation", lifecycleRevision: 2,
	cwd: "/fixture", model: "test", lastActivity: 10, turnState: "prompt", enteredStateAt: 10, bucket: "NEEDS_YOU", reason: "prompt", permissions: [] };
const unrelated: HubSession = { ...prompt, id: "other", bucket: "PARKED", turnState: "returned", reason: null };
const snapshot = (session: HubSession, other = unrelated) => ({ connected: true, sessions: [session, other] });

test("successful gate follow-through applies one newer authoritative state only to exact runtime", () => {
	const board = new CheckinBoard(0);
	board.receive(snapshot(prompt), 1);
	board.followPermission(prompt, "gate", prompt, 2);
	assert.equal(board.receive(snapshot({ ...prompt }), 3), false, "same lifecycle is not an action follow-up");
	assert.equal(board.receive(snapshot({ ...prompt, lifecycleRevision: 3 }), 3), false, "non-transition metadata does not consume prompt-end follow-through");
	const working: HubSession = { ...prompt, turnState: "running", lifecycleRevision: 4, bucket: "WORKING", reason: null };
	const otherWorking: HubSession = { ...unrelated, turnState: "running", bucket: "WORKING" };
	assert.equal(board.receive(snapshot(working, otherWorking), 4), true);
	assert.equal(board.displayed.sessions[0].bucket, "WORKING");
	assert.equal(board.displayed.sessions[1].bucket, "PARKED", "unrelated pending cards remain frozen");
	board.receive(snapshot({ ...working, turnState: "returned", lifecycleRevision: 5, bucket: "REVIEW" }), 5);
	assert.equal(board.displayed.sessions[0].bucket, "WORKING", "only one asynchronous follow-up is promoted");
});

test("follow-through preserves a genuinely new prompt and never crosses runtime, disconnect or deadline", () => {
	const board = new CheckinBoard(0);
	board.receive(snapshot(prompt), 1); board.followPermission(prompt, "gate", prompt, 2);
	const newPrompt: HubSession = { ...prompt, lifecycleRevision: 4, enteredStateAt: 20 };
	board.receive(snapshot(newPrompt), 3);
	assert.equal(board.displayed.sessions[0].turnState, "prompt");
	assert.equal(board.displayed.sessions[0].enteredStateAt, 20);
	for (const changed of [{ endpointEpoch: "replacement" }, { lifecycleGeneration: "replacement" }, { pid: 43 }, { startedAt: 2 }]) {
		const isolated = new CheckinBoard(0);
		isolated.receive(snapshot(prompt), 1); isolated.followPermission(prompt, "gate", prompt, 2);
		isolated.receive(snapshot({ ...newPrompt, ...changed }), 3);
		assert.equal(isolated.displayed.sessions[0].enteredStateAt, 10);
	}
	for (const disconnect of [false, true]) {
		const isolated = new CheckinBoard(0);
		isolated.receive(snapshot(prompt), 1); isolated.followPermission(prompt, "gate", prompt, 2);
		if (disconnect) isolated.receive({ connected: false, sessions: [] }, 3);
		isolated.receive(snapshot(newPrompt), disconnect ? 4 : 5002);
		assert.equal(isolated.displayed.sessions[0].enteredStateAt, 10);
	}
});

test("response prompt anchors follow-through when pre-click metadata lagged or was absent", () => {
	const working: HubSession = { ...prompt, turnState: "running", bucket: "WORKING", reason: null, lifecycleRevision: 3 };
	for (const missing of [false, true]) {
		const before: HubSession = { ...prompt, turnState: missing ? undefined : "running", lifecycleGeneration: missing ? undefined : prompt.lifecycleGeneration, lifecycleRevision: missing ? undefined : 1 };
		for (const arrivedEarly of [false, true]) {
			const board = new CheckinBoard(0);
			board.receive(snapshot(prompt), 1); // successful response already applied
			if (arrivedEarly) board.receive(snapshot(working), 2);
			board.followPermission(before, "gate", prompt, 3);
			if (!arrivedEarly) board.receive(snapshot(working), 4);
			assert.equal(board.displayed.sessions[0].bucket, "WORKING");
		}
	}
	for (const mismatch of [{ id: "replacement" }, { pid: 43 }, { startedAt: 2 }, { endpointEpoch: "replacement" }, { lifecycleGeneration: "replacement" }]) {
		const board = new CheckinBoard(0);
		const replacement = { ...prompt, ...mismatch };
		board.receive(snapshot(replacement), 1);
		board.followPermission(prompt, "gate", replacement, 2);
		board.receive(snapshot({ ...replacement, turnState: "running", bucket: "WORKING", lifecycleRevision: 3 }), 3);
		assert.equal(board.displayed.sessions[0].bucket, "NEEDS_YOU", "never arm against a response from a replaced runtime");
	}
});
