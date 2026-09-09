import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	findTmuxPaneForPid,
	focusPiSession,
	parseProcessParents,
	parseTmuxPanes,
} from "../extensions/lib/pi-hub-navigation.ts";

const processTable = `
55355 54907
54907 6006
6006 1
95365 94579
94579 94573
94573 1
23678 4308
4308 4306
4306 1
`;

function fixtureRunner(calls) {
	return (command, args) => {
		calls.push([command, args]);
		if (command === "ps") return processTable;
		if (command === "tmux" && args[0] === "list-panes") {
			return "0\t@3\t%3\t54907\n0\t@4\t%4\t84351";
		}
		if (command === "tmux" && args[0] === "list-clients") {
			return "/dev/ttys005\t95365\t0\t200";
		}
		if (command === "aerospace" && args[0] === "list-windows") {
			const pid = args[args.indexOf("--pid") + 1];
			if (pid === "94573") return "14959\t1\tGhostty";
			if (pid === "4306") return "822\t2\tGhostty";
			return "";
		}
		if (command === "tmux" || command === "aerospace") return "";
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
}

describe("Pi Hub navigation", () => {
	test("maps a nested Pi process to its nearest tmux pane", () => {
		const parents = parseProcessParents(processTable);
		const panes = parseTmuxPanes("0\t@3\t%3\t54907\n0\t@4\t%4\t84351");
		assert.deepEqual(findTmuxPaneForPid(55355, panes, parents), {
			session: "0",
			windowId: "@3",
			paneId: "%3",
			pid: 54907,
		});
	});

	test("selects the tmux window and pane before focusing its AeroSpace window", async () => {
		const calls = [];
		const target = await focusPiSession(55355, fixtureRunner(calls));
		assert.equal(target.pane.paneId, "%3");
		assert.equal(target.window.id, "14959");
		assert.deepEqual(calls.slice(-3), [
			["tmux", ["select-window", "-t", "@3"]],
			["tmux", ["select-pane", "-t", "%3"]],
			["aerospace", ["focus", "--window-id", "14959"]],
		]);
	});

	test("focuses a direct Pi process without issuing tmux selection commands", async () => {
		const calls = [];
		const target = await focusPiSession(23678, fixtureRunner(calls));
		assert.equal(target.pane, undefined);
		assert.equal(target.window.id, "822");
		assert.deepEqual(calls.at(-1), [
			"aerospace",
			["focus", "--window-id", "822"],
		]);
		assert.equal(
			calls.some(
				([command, args]) =>
					command === "tmux" &&
					(args[0] === "select-window" || args[0] === "select-pane"),
			),
			false,
		);
	});
});
