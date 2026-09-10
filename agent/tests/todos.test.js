import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extension = join(root, "agent/extensions/todos.ts");
const overlay = join(root, "agent/extensions/lib/todo-overlay.ts");
const store = join(root, "agent/npm/node_modules/@juicesharp/rpiv-todo/state/store.ts");

function loadCommands(path, configHome) {
	const result = spawnSync("pi", [
		"--offline", "--mode", "rpc", "--no-session", "--no-extensions",
		"--no-skills", "--no-prompt-templates", "--no-context-files", "-e", path,
	], {
		cwd: root,
		env: { ...process.env, XDG_CONFIG_HOME: configHome },
		encoding: "utf8",
		input: '{"type":"get_commands","id":"todos-test"}\n',
		timeout: 20_000,
	});
	assert.equal(result.status, 0, result.stderr);
	const messages = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const response = messages.find((message) => message.id === "todos-test");
	assert.ok(response?.data?.commands, result.stderr || result.stdout);
	assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
	return response.data.commands;
}

function fixtureDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-todos-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	mkdirSync(join(dir, "rpiv-todo"));
	writeFileSync(join(dir, "rpiv-todo/config.json"), JSON.stringify({ collapseKey: "ctrl+shift+t" }));
	return dir;
}

test("todo overlay supports one-row summaries, clicks, and upstream lifecycle", (t) => {
	const dir = fixtureDir(t);
	const fixture = join(dir, "widget.ts");
	writeFileSync(fixture, String.raw`
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoOverlay } from ${JSON.stringify(pathToFileURL(overlay).href)};
import { __resetState, replaceState, setActiveRenderSession } from ${JSON.stringify(pathToFileURL(store).href)};

export default function (pi) {
	__resetState();
	setActiveRenderSession("foreground");
	const tasks = [
		{ id: 1, subject: "Completed setup", status: "completed" },
		{ id: 2, subject: "Implement the widget", activeForm: "implementing", status: "in_progress" },
		{ id: 3, subject: "Write tests", status: "pending" },
		{ id: 4, subject: "Deleted task", status: "deleted" },
	];
	const setTasks = (next) => replaceState("foreground", { tasks: next, nextId: 5 });
	setTasks(tasks);
	const renders = [];
	const tui = { requestRender: (force) => renders.push(force) };
	const theme = { fg: (_color, text) => text, strikethrough: (text) => text, bold: (text) => text };
	let widget;
	let registrations = 0;
	const ui = {
		theme,
		getToolsExpanded: () => false,
		setWidget(key, factory) {
			assert.equal(key, "rpiv-todos");
			registrations++;
			widget = factory?.(tui, theme);
		},
	};
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	assert.ok(widget.render(80).length > 1, "starts expanded");
	overlay.setUICtx(ui);
	overlay.update();
	assert.equal(registrations, 1, "same UI remains registered once");

	const click = { type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 10, width: 80, height: 5 };
	assert.equal(widget.handleMouse(click)?.handled, true, "heading is clickable");
	assert.deepEqual(widget.render(80), ["Todos (1/3) - Implement the widget"]);
	assert.equal(renders.at(-1), true, "height changes force a redraw");
	assert.ok(visibleWidth(widget.render(14)[0]) <= 14, "narrow terminals do not overflow");
	assert.equal(widget.handleMouse({ ...click, type: "wheel", wheelDelta: -1 }), undefined, "wheel falls through to transcript");
	assert.equal(widget.handleMouse({ ...click, button: "right" }), undefined);
	assert.equal(widget.handleMouse({ ...click, type: "press" }), undefined, "press must not toggle twice with click");
	assert.deepEqual(widget.render(80), ["Todos (1/3) - Implement the widget"]);

	overlay.toggleCollapse();
	assert.ok(widget.render(80).length > 1, "keyboard path expands after click collapse");
	assert.equal(widget.handleMouse({ ...click, y: 1 }), undefined, "task rows do not toggle");
	widget.handleMouse(click);
	setTasks(tasks.map((task) => task.id === 2 ? { ...task, status: "completed" } : task));
	assert.deepEqual(widget.render(80), ["Todos (2/3) - Write tests"], "falls back to pending subject, not activeForm");
	setTasks([{ id: 1, subject: "Long\n名前\t🎉", status: "in_progress" }]);
	assert.deepEqual(widget.render(80), ["Todos (0/1) - Long 名前 🎉"]);
	assert.ok(visibleWidth(widget.render(12)[0]) <= 12, "wide characters fit");

	setTasks(tasks);
	overlay.resetCompletedDisplayState();
	widget.render(80);
	overlay.hideCompletedTasksFromPreviousTurn();
	assert.deepEqual(widget.render(80), ["Todos (1/3) - Implement the widget"], "progress includes hidden completed tasks");
	replaceState("child", { tasks: [{ id: 1, subject: "Child task", status: "in_progress" }], nextId: 2 });
	assert.deepEqual(widget.render(80), ["Todos (1/3) - Implement the widget"], "child state cannot leak into summary");

	setTasks([{ id: 1, subject: "Finished task", status: "completed" }]);
	overlay.resetCompletedDisplayState();
	assert.deepEqual(widget.render(80), ["Todos (1/1) - Finished task"]);
	overlay.hideCompletedTasksFromPreviousTurn();
	assert.deepEqual(widget.render(80), [], "completed-only list still disappears next turn");
	setTasks([]);
	overlay.update();
	assert.equal(widget, undefined, "empty lists unregister");

	setTasks(tasks);
	overlay.update();
	assert.deepEqual(widget.render(80), ["Todos (1/3) - Implement the widget"], "collapse survives temporary empty list");
	overlay.dispose();
	assert.equal(widget, undefined);
	overlay.setUICtx(ui);
	overlay.update();
	assert.ok(widget.render(80).length > 1, "dispose resets collapsed state");
	ui.theme = { ...theme, fg: (_color, text) => "[" + text + "]" };
	overlay.toggleCollapse();
	widget.invalidate();
	assert.ok(widget.render(80)[0].includes("["), "theme is read live");
	overlay.dispose();
	pi.registerCommand("todo-widget-test-passed", { handler: async () => {} });
}
`);
	assert.ok(loadCommands(fixture, dir).some((command) => command.name === "todo-widget-test-passed"));
});

test("local todo entrypoint retains the upstream command and single collapse shortcut", (t) => {
	const dir = fixtureDir(t);
	const fixture = join(dir, "registration.ts");
	writeFileSync(fixture, `
import assert from "node:assert/strict";
import todos from ${JSON.stringify(pathToFileURL(extension).href)};
export default async function (pi) {
	const tools = [], commands = [], shortcuts = new Map(), handlers = new Map();
	todos({
		on: (event, handler) => handlers.set(event, handler),
		registerTool: (tool) => tools.push(tool),
		registerCommand: (name) => commands.push(name),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
	});
	assert.equal(tools.filter((tool) => tool.name === "todo").length, 1);
	assert.deepEqual(commands, ["todos"]);
	assert.deepEqual([...shortcuts.keys()], ["ctrl+shift+t"]);
	let widget;
	const theme = { fg: (_color, text) => text, strikethrough: (text) => text };
	const ctx = {
		hasUI: true,
		sessionManager: { getSessionId: () => "integration", getBranch: () => [] },
		ui: { theme, setWidget: (_key, factory) => { widget = factory?.({ requestRender() {} }, theme); } },
	};
	await handlers.get("session_start")({}, ctx);
	assert.equal(widget, undefined);
	const result = await tools[0].execute("create", { action: "create", subject: "Integrated task" }, undefined, undefined, ctx);
	await handlers.get("tool_execution_end")({ toolName: "todo", isError: false, result }, ctx);
	assert.ok(widget.render(80).length > 1, "real tool mutation registers the customized widget");
	await shortcuts.get("ctrl+shift+t").handler(ctx);
	assert.deepEqual(widget.render(80), ["Todos (0/1) - Integrated task"], "registered shortcut targets the same overlay");
	assert.equal(widget.handleMouse({ type: "click", button: "left", y: 0 })?.handled, true);
	assert.ok(widget.render(80).length > 1);
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal(widget, undefined);
	await shortcuts.get("ctrl+shift+t").handler(ctx);
	pi.registerCommand("todo-registration-test-passed", { handler: async () => {} });
}
`);
	assert.ok(loadCommands(fixture, dir).some((command) => command.name === "todo-registration-test-passed"));
	assert.equal(loadCommands(extension, dir).filter((command) => command.name === "todos").length, 1);
	const settings = JSON.parse(readFileSync(join(root, "agent/settings.json"), "utf8"));
	const pkg = settings.packages.find((entry) => entry.source === "npm:@juicesharp/rpiv-todo");
	assert.deepEqual(pkg?.extensions, [], "upstream auto-entrypoint is disabled to avoid duplicate registration");
});
