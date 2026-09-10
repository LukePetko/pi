import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeHubTodos } from "../extensions/lib/hub-todos.ts";
import { withHubTodos } from "../extensions/lib/hub-todo-source.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome = process.env.PI_HUB_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("Hub todo panels are safe, keyboard/click collapsible, live, independent, and mobile-friendly", {
	skip: !existsSync(chrome), timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hub-todo-browser-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessions = ["Alpha", "Beta"].map((name, index) => ({
		id: name, name, pid: 8000 + index, startedAt: Date.now(), lastActivity: Date.now(),
		cwd: "/test", model: "Test model", status: "idle",
	}));
	let state = { connected: true, sessions };
	const listeners = new Set<() => void>();
	const focused = [];
	const tasks = [
		{ id: 1, subject: "Setup", status: "completed" },
		{ id: 2, subject: "Build widget", status: "in_progress" },
		{ id: 3, subject: "<img src=x onerror=window.pwned=true>", status: "pending" },
	];
	await writeHubTodos(directory, sessions[0], tasks);
	await writeHubTodos(directory, sessions[1], [{ id: 1, subject: "Other session task", status: "pending" }]);
	const source = withHubTodos({
		snapshot: () => state,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		resolveSession: async (id) => state.sessions.find((session) => session.id === id),
	}, { directory, pollMs: 20 });
	const token = "c".repeat(64);
	const hub = await startHubServer({ token, source, focus: async (pid) => { focused.push(pid); } });
	t.after(() => hub.close());
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor('document.querySelectorAll(".todos").length === 2');
	assert.equal(await browser.evaluate('document.querySelector(".todos-summary").textContent'), "Todos (1/3) - Build widget");
	assert.equal(await browser.evaluate('document.querySelectorAll(".todos[open]").length'), 0);
	await browser.evaluate('document.querySelector(".todos-summary").click()');
	await browser.waitFor('document.querySelector(".todos").open');
	assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".todo-current")).display'), "none");
	assert.equal(await browser.evaluate('document.querySelectorAll(".todos")[1].open'), false);
	assert.equal(await browser.evaluate('document.querySelectorAll(".todo-list img").length'), 0);
	assert.equal(await browser.evaluate("window.pwned === undefined"), true);
	assert.deepEqual(focused, [], "opening todos must not focus a terminal");
	await browser.evaluate('document.querySelector(".todos-summary").focus()');
	await browser.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
	await browser.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await browser.waitFor('!document.querySelector(".todos").open');
	await browser.evaluate('document.querySelector(".todos-summary").click()');
	await writeHubTodos(directory, sessions[0], [
		...tasks.map((task) => task.id === 2 ? { ...task, status: "completed" } : task),
		{ id: 4, subject: "Review changes", status: "in_progress" },
	]);
	await browser.waitFor('document.querySelector(".todos-count").textContent === "Todos (2/4)"');
	assert.equal(await browser.evaluate('document.querySelector(".todos").open'), true, "live task updates preserve open state");
	assert.equal(await browser.evaluate('document.querySelector(".todo-current").textContent'), " - Review changes");
	state = { ...state, sessions: state.sessions.map((session) => session.id === "Beta" ? { ...session, status: "thinking" } : session) };
	for (const listener of listeners) listener();
	await browser.waitFor('document.querySelector("h2").textContent === "Beta"');
	assert.equal(await browser.evaluate('document.querySelector(".todos[open]").closest(".card").querySelector("h2").textContent'), "Alpha", "sorting does not transfer collapse state between sessions");
	await browser.evaluate('document.querySelector("#search").value = "Alpha"; document.querySelector("#search").dispatchEvent(new Event("input"))');
	assert.equal(await browser.evaluate('document.querySelectorAll(".card:not([hidden])").length'), 1);
	assert.equal(await browser.evaluate('document.querySelector(".card:not([hidden]) .todos").open'), true);
	await browser.evaluate('document.querySelector(".card:not([hidden]) button").click()');
	await browser.waitFor('!document.querySelector(".card:not([hidden]) button").disabled');
	assert.deepEqual(focused, [8000]);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
	await writeHubTodos(directory, sessions[0], []);
	await browser.waitFor('document.querySelector(".card:not([hidden]) .todos").hidden');
	state = { connected: false, sessions: [] };
	for (const listener of listeners) listener();
	await browser.waitFor('document.querySelectorAll(".card").length === 0');
	assert.deepEqual(browser.exceptions, []);
});
