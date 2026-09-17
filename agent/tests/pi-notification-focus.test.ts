import assert from "node:assert/strict";
import { test } from "node:test";
import { isPiSessionFocused, type FocusCommandRunner } from "../extensions/lib/pi-notification-focus.ts";

function fixture(options: {
	focused?: string;
	clients?: string;
	windows?: string;
	processes?: string;
	panes?: string;
} = {}): FocusCommandRunner {
	return async (command, args) => {
		if (command === "ps") return options.processes ?? "42 100\n100 1\n1000 2000\n2000 1\n1100 2100\n2100 1";
		if (command === "tmux" && args[0] === "list-panes") return options.panes ?? "pi\t@1\t%1\t100";
		if (command === "tmux" && args[0] === "list-clients") return options.clients ?? "1000\t%1\n1100\t%2";
		if (command === "aerospace" && args.includes("--focused")) return options.focused ?? "10";
		if (command === "aerospace") return options.windows ?? "10\t2000\n20\t2100";
		throw new Error(`Unexpected focus command: ${command}`);
	};
}

test("requires both the Pi's selected tmux pane and its foreground native window", async () => {
	assert.equal(await isPiSessionFocused(42, fixture()), true);
	assert.equal(await isPiSessionFocused(42, fixture({ focused: "20" })), false);
	assert.equal(await isPiSessionFocused(42, fixture({ clients: "1000\t%2" })), false);
	assert.equal(await isPiSessionFocused(42, fixture({ focused: "" })), false);
});

test("checks the actual focused client, not whichever client was most recently attached", async () => {
	assert.equal(await isPiSessionFocused(42, fixture({ focused: "20", clients: "1000\t%2\n1100\t%1" })), true);
});

test("ambiguous windows or multiple terminal clients sharing a window preserve notifications", async () => {
	assert.equal(await isPiSessionFocused(42, fixture({ windows: "10\t2000\n11\t2000\n20\t2100" })), false);
	assert.equal(await isPiSessionFocused(42, fixture({ processes: "42 100\n100 1\n1000 2000\n1100 2000\n2000 1" })), false);
});

test("unattached, missing, non-tmux, and malformed targets never count as focused", async () => {
	assert.equal(await isPiSessionFocused(42, fixture({ clients: "" })), false);
	assert.equal(await isPiSessionFocused(42, fixture({ panes: "" })), false);
	assert.equal(await isPiSessionFocused(9999, fixture()), false);
	assert.equal(await isPiSessionFocused(42, fixture({ windows: "10\tnot-a-pid" })), false);
	assert.equal(await isPiSessionFocused(42, fixture({ clients: "bad-data" })), false);
});

test("probe failures and process ancestry cycles do not dismiss notifications", async () => {
	assert.equal(await isPiSessionFocused(42, async () => { throw new Error("AeroSpace unavailable"); }), false);
	assert.equal(await isPiSessionFocused(42, fixture({ processes: "42 100\n100 1\n1000 1100\n1100 1000" })), false);
});
