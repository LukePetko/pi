import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(join(root, "agent/extensions", name)).href);

test("real permission preview is shared with Hub, rendered yellow, and dismissed by web approval", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "hub-permissions-load-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const fixture = join(dir, "permission-fixture.ts");
	writeFileSync(fixture, String.raw`
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import confirmDialog from ${moduleUrl("confirm-dialog.ts")};
import piHub from ${moduleUrl("pi-hub.ts")};
import { performNativePermissionAction, processBirth } from ${moduleUrl("lib/native-permission-action.ts")};
import { createPermissionBroker, permissionDirectory, readPermissionSummaries, inspectPermission, decidePermission } from ${moduleUrl("lib/hub-permissions.ts")};

export default async function (pi) {
	process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(join(dir, "agent"))};
	process.env.PI_INTERCOM_STABLE_ID = "permission-fixture";
	const directory = permissionDirectory();
	const session = { id: "permission-fixture", name: "Preview session", pid: process.pid, startedAt: Date.now() - 1000, lastActivity: Date.now(), cwd: "/project", model: "test", status: "idle" };
	const permissionHandlers = new Map(), permissionCommands = new Map();
	const notificationEvents = [];
	for (const name of ["pi:permission-requested", "pi:permission-resolved"]) {
		pi.events.on(name, (data) => notificationEvents.push({ name, data }));
	}
	confirmDialog({ events: pi.events, on: (name, handler) => permissionHandlers.set(name, handler), registerCommand: (name, command) => permissionCommands.set(name, command) }, () => createPermissionBroker(directory));
	const hubHandlers = new Map(), hubCommands = new Map();
	piHub({
		on: (name, handler) => hubHandlers.set(name, handler),
		registerCommand: (name, command) => hubCommands.set(name, command), registerShortcut() {},
		events: { emit: (_name, registration) => registration.onReady({ listSessions: async () => [session], snapshot: () => ({ connected: true, supported: true }) }) },
	});
	let dialog, hub, closeHub, doneCount = 0;
	const colors = [], notices = [];
	const theme = { fg: (color, text) => { colors.push({ color, text }); return text; }, bg: (_color, text) => text, inverse: (text) => text };
	const ctx = {
		hasUI: true, mode: "tui", cwd: session.cwd,
		sessionManager: { getSessionId: () => session.id },
		ui: {
			notify: (message) => notices.push(message),
			custom: (factory, options) => new Promise((resolve) => {
				const component = factory({ requestRender() {} }, theme, {}, (result) => { if (!options?.overlay) doneCount++; resolve(result); });
				if (options?.overlay) { hub = component; closeHub = resolve; } else dialog = component;
			}),
		},
	};
	async function waitFor(predicate) {
		for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(10); }
		assert.fail("Timed out waiting for permission UI");
	}
	const preview = permissionCommands.get("confirm-dialog").handler("test", ctx);
	try {
		await waitFor(async () => dialog && (await readPermissionSummaries(session, directory)).length === 1);
		const request = (await readPermissionSummaries(session, directory))[0];
		const full = await inspectPermission(session, request.id, directory);
		assert.equal(full.description, '$ echo "Hello from Pi"');
		assert.equal(JSON.parse(full.input).command, 'echo "Hello from Pi"');
		assert.match(full.title, /nothing executes/);
		assert.equal(notificationEvents.length, 1);
		assert.equal(notificationEvents[0].name, "pi:permission-requested");
		assert.deepEqual(Object.keys(notificationEvents[0].data).sort(), ["broker", "cwd", "id", "title"], "notification payload must omit command/input details");
		assert.equal(notificationEvents[0].data.id, request.id);
		assert.deepEqual(notificationEvents[0].data.broker, { session: { id: session.id, pid: process.pid }, requestId: request.id, directory });
		assert.equal(notificationEvents[0].data.cwd, session.cwd);
		assert.equal(notificationEvents[0].data.title, full.title);
		await hubHandlers.get("session_start")({}, ctx);
		const viewingHub = hubCommands.get("hub").handler("", ctx);
		await waitFor(() => hub !== undefined && hub.render(180).join("\n").includes("Permission needed"));
		colors.length = 0;
		assert.match(hub.render(180).join("\n"), /Permission needed/);
		assert.ok(colors.some(({ color, text }) => color === "warning" && text === "Permission needed"), "label must be yellow, not just its dot");
		await decidePermission(session, request.id, "once", directory);
		await preview;
		assert.deepEqual(notificationEvents[1], { name: "pi:permission-resolved", data: { id: notificationEvents[0].data.id } });
		assert.equal(doneCount, 1, "browser approval closes the real local dialog");
		dialog.handleInput("\x1b");
		assert.equal(doneCount, 1, "stale local input cannot resolve a second time");
		assert.ok(notices.includes("Preview result: once"));
		hub.handleInput("r");
		await waitFor(() => !hub.render(180).join("\n").includes("Permission needed"));
		closeHub(); await viewingHub;
		await hubHandlers.get("session_shutdown")({}, ctx);
		dialog = undefined;
		const rejected = permissionCommands.get("confirm-dialog").handler("test", ctx);
		await waitFor(() => dialog !== undefined && notificationEvents.length === 3);
		dialog.handleInput("\x1b");
		await rejected;
		await waitFor(async () => (await readPermissionSummaries(session, directory)).length === 0);
		assert.ok(notices.includes("Preview result: reject"));
		assert.equal(notificationEvents.length, 4);
		assert.notEqual(notificationEvents[2].data.id, notificationEvents[0].data.id);
		assert.deepEqual(notificationEvents[3], { name: "pi:permission-resolved", data: { id: notificationEvents[2].data.id } });
		dialog = undefined;
		const nativeAccepted = permissionCommands.get("confirm-dialog").handler("test", ctx);
		await waitFor(() => dialog !== undefined && notificationEvents.length === 5);
		await performNativePermissionAction({ version: 1, actionable: true, target: { pid: process.pid, startedAt: processBirth(process.pid) }, broker: notificationEvents[4].data.broker }, "accept");
		await nativeAccepted;
		assert.equal(notificationEvents.length, 6);
		assert.deepEqual(notificationEvents[5], { name: "pi:permission-resolved", data: { id: notificationEvents[4].data.id } });
		assert.equal(doneCount, 3, "native Accept closes the same live local dialog");
		await assert.rejects(permissionCommands.get("confirm-dialog").handler("test", { ...ctx, ui: { ...ctx.ui, custom: async () => { throw new Error("UI cancelled"); } } }), /UI cancelled/);
		await delay(20);
		assert.equal(notificationEvents.length, 6, "cancelled UI cannot publish a late alert");
		await permissionCommands.get("confirm-dialog").handler("test", { ...ctx, hasUI: false });
		assert.equal(notificationEvents.length, 6, "headless requests must not create alerts");
		const delayedHandlers = new Map(), delayedCommands = new Map();
		let release;
		confirmDialog({ events: pi.events, on: (name, handler) => delayedHandlers.set(name, handler), registerCommand: (name, command) => delayedCommands.set(name, command) }, () => new Promise((resolve) => { release = resolve; }));
		const waiting = delayedCommands.get("confirm-dialog").handler("test", ctx);
		const shutdown = delayedHandlers.get("session_shutdown")({}, ctx);
		release(await createPermissionBroker(directory));
		await Promise.all([waiting, shutdown]);
		assert.equal(doneCount, 3, "shutdown during broker startup must not open a late dialog");
		assert.equal(notificationEvents.length, 6, "shutdown during startup must not create a late alert");
	} finally { closeHub?.(); await permissionHandlers.get("session_shutdown")({}, ctx); }
	pi.registerCommand("permission-integration-passed", { handler: async () => {} });
}
`);
	const result = spawnSync("pi", ["--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", fixture], {
		cwd: root, encoding: "utf8", input: '{"type":"get_commands","id":"permissions-test"}\n', timeout: 20_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
	const response = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === "permissions-test");
	assert.ok(response?.data?.commands.some((command) => command.name === "permission-integration-passed"), result.stderr || result.stdout);
});
