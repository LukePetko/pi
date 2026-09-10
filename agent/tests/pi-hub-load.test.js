import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, "../..");
const extensionPath = resolve(testDir, "../extensions/pi-hub.ts");

function loadCommands(extensionPath) {
	const result = spawnSync(
		"pi",
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension",
			extensionPath,
		],
		{
			cwd: projectRoot,
			encoding: "utf8",
			input: '{"type":"get_commands","id":"pi-hub-load-test"}\n',
			timeout: 20_000,
		},
	);

	assert.equal(result.status, 0, result.stderr);
	const messages = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const response = messages.find(
		(message) =>
			message.type === "response" && message.id === "pi-hub-load-test",
	);
	assert.ok(response, "get_commands response missing");
	assert.ok(Array.isArray(response.data.commands), "commands list missing");
	return response.data.commands;
}

test("Pi loads the Hub extension and registers /hub", () => {
	const hub = loadCommands(extensionPath).find((command) => command.name === "hub");
	assert.ok(hub, "/hub command missing");

	assert.equal(hub.name, "hub");
	assert.equal(hub.description, "Show and focus local Pi sessions");
	assert.equal(hub.source, "extension");
	assert.equal(hub.sourceInfo.path, extensionPath);
});

test("Ctrl+H opens the same Hub overlay as /hub", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-hub-shortcut-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fixture = join(dir, "shortcut-test.ts");
	writeFileSync(fixture, `
import assert from "node:assert/strict";
import hub from ${JSON.stringify(pathToFileURL(extensionPath).href)};

export default async function (pi) {
	const commands = new Map();
	const shortcuts = new Map();
	hub({
		on() {},
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
	});
	const shortcut = shortcuts.get("ctrl+h");
	assert.ok(shortcut, "Ctrl+H shortcut missing");
	assert.equal(shortcut.description, commands.get("hub").description);
	const overlays = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { custom: async (_factory, options) => overlays.push(options) },
	};
	await commands.get("hub").handler("", ctx);
	await shortcut.handler(ctx);
	assert.equal(overlays.length, 2);
	assert.equal(overlays[0].overlay, true);
	assert.deepEqual(overlays[1], overlays[0]);
	pi.registerCommand("hub-shortcut-test-passed", { handler: async () => {} });
}
`);
	assert.ok(
		loadCommands(fixture).some((command) => command.name === "hub-shortcut-test-passed"),
		"Hub shortcut assertions failed during extension loading",
	);
});
