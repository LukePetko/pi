import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { loadHubBrowserAsset } from "../extensions/lib/hub-browser-assets.ts";

const directory = new URL("../extensions/lib/pi-hub-web/", import.meta.url);

test("Hub compiles its TypeScript modules to browser ESM without generating files", async () => {
	const before = await readdir(directory);
	assert.ok(before.includes("app.ts") && before.includes("todos.ts"));
	assert.equal(before.some((name) => /\.[cm]?jsx?$/.test(name)), false);
	const app = await loadHubBrowserAsset("app.ts");
	const todos = await loadHubBrowserAsset("todos.ts");
	assert.match(app, /from ["']\.\/todos\.js["']/);
	assert.doesNotMatch(app, /import type|: HubSnapshot|<HTMLInputElement>/);
	assert.match(todos, /export\s*\{\s*renderTodos/);
	assert.doesNotMatch(todos, /import type|: HTMLElement|: HTMLDetailsElement/);
	assert.deepEqual(await readdir(directory), before, "compilation must remain in memory");
});

test("non-code assets are unchanged and missing assets fail startup", async () => {
	assert.equal(await loadHubBrowserAsset("index.html"), await readFile(new URL("index.html", directory), "utf8"));
	assert.equal(await loadHubBrowserAsset("style.css"), await readFile(new URL("style.css", directory), "utf8"));
	await assert.rejects(loadHubBrowserAsset("missing.ts"), { code: "ENOENT" });
});
