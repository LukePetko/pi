import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionBroker, inspectPermission, decidePermission } from "../extensions/lib/hub-permissions.ts";
import { withHubTodos } from "../extensions/lib/hub-todo-source.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome = process.env.PI_HUB_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("full permission requests appear in yellow and browser approval resolves the live owner", {
	skip: !existsSync(chrome), timeout: 30_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "hub-permission-browser-"));
	const broker = await createPermissionBroker(directory);
	t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true }); });
	const session = { id: "test", name: "Permission test", pid: process.pid, startedAt: Date.now() - 1000, lastActivity: Date.now(), cwd: "/project", model: "test", status: "idle" };
	const decisions = [];
	const input = JSON.stringify({ command: 'echo "<img src=x onerror=window.pwned=true>"', content: "LONG-CONTENT\n".repeat(1000) + "END-OF-REQUEST" }, null, 2);
	const details = { title: "Echo permission preview", description: '$ echo "Hello from Pi"', cwd: session.cwd, toolName: "bash", input };
	const ticket = broker.request(session, details, (decision) => decisions.push(decision));
	await ticket.ready;
	const source = withHubTodos({
		snapshot: () => ({ connected: true, sessions: [session] }), subscribe: () => () => {},
		resolveSession: async (id) => id === session.id ? session : undefined,
	}, { directory: join(directory, "todos"), permissionDirectory: directory, pollMs: 20 });
	const token = "d".repeat(64);
	const focused = [];
	const hub = await startHubServer({ token, source, focus: async (pid) => { focused.push(pid); }, permissions: {
		inspect: (owner, id) => inspectPermission(owner, id, directory),
		decide: (owner, id, decision) => decidePermission(owner, id, decision, directory),
	} });
	t.after(() => hub.close());
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor('document.querySelector(".permission-input") && !document.querySelector("[data-decision=once]").disabled');
	assert.equal(await browser.evaluate('document.querySelector(".activity").textContent'), "Permission needed");
	assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(".activity")).color'), "rgb(237, 203, 116)");
	assert.equal(await browser.evaluate('document.querySelector(".permission-input").textContent'), input, "full input is shown without truncation");
	assert.equal(await browser.evaluate('document.querySelectorAll(".permission-request img").length'), 0);
	assert.equal(await browser.evaluate("window.pwned === undefined"), true);
	assert.deepEqual(decisions, [], "viewing a request never approves it");
	assert.doesNotMatch(JSON.stringify(source.snapshot()), /LONG-CONTENT|END-OF-REQUEST|Bearer|token/);
	const api = (decision, headers = {}) => fetch(`${hub.origin}/api/permissions/decision`, {
		method: "POST", headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ id: session.id, requestId: ticket.id, decision }),
	});
	assert.equal((await api("once")).status, 401);
	assert.equal((await api("once", { Authorization: `Bearer ${token}`, Origin: "https://evil.example" })).status, 403);
	assert.equal((await api("always", { Authorization: `Bearer ${token}`, Origin: hub.origin })).status, 400);
	assert.deepEqual(decisions, []);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
	await browser.evaluate('document.querySelector("[data-decision=once]").click()');
	await browser.waitFor('!document.querySelector(".permission-request")');
	assert.deepEqual(decisions, ["once"]);
	assert.deepEqual(focused, [], "permission controls never trigger Focus terminal");
	assert.equal(await browser.evaluate('document.querySelector(".activity").textContent'), "idle");
	assert.equal((await api("once", { Authorization: `Bearer ${token}`, Origin: hub.origin })).status, 409);
	const local = broker.request(session, details, (decision) => decisions.push(decision));
	await local.ready;
	await browser.waitFor('document.querySelector(".permission-input")');
	local.decide("reject");
	await browser.waitFor('!document.querySelector(".permission-request")');
	assert.deepEqual(decisions, ["once", "reject"]);
	assert.deepEqual(browser.exceptions, []);
});
