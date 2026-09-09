import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDir, "../..");
const extensionPath = resolve(testDir, "../extensions/pi-hub.ts");

test("Pi loads the Hub extension and registers /hub", () => {
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
	const hub = response.data.commands.find((command) => command.name === "hub");
	assert.ok(hub, "/hub command missing");

	assert.equal(hub.name, "hub");
	assert.equal(hub.description, "Show and focus local Pi sessions");
	assert.equal(hub.source, "extension");
	assert.equal(hub.sourceInfo.path, extensionPath);
});
