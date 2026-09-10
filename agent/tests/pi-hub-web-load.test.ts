import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("Pi loads /hub-web without launching a server during extension discovery", () => {
	const extension = resolve("agent/extensions/pi-hub-web.ts");
	const result = spawnSync("pi", [
		"--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--extension", extension,
	], { encoding: "utf8", input: '{"type":"get_commands","id":"hub-web-load"}\n', timeout: 20_000 });
	assert.equal(result.status, 0, result.stderr);
	const messages = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const response = messages.find((message) => message.id === "hub-web-load");
	const command = response?.data?.commands.find((item) => item.name === "hub-web");
	assert.ok(command, "/hub-web command missing");
	assert.equal(command.sourceInfo.path, extension);
	assert.match(command.description, /stop/);
});
