import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPermissionBroker, inspectPermission, decidePermission } from "../extensions/lib/hub-permissions.ts";
import { startHubServer, type HubSession } from "../extensions/lib/pi-hub-web-server.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome = process.env.PI_HUB_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const token = "d".repeat(64);
const card = (id: string) => `document.querySelector('[data-session-id="${id}"]')`;

test("Phase 1 acceptance: three buckets, frozen updates, high-risk breakthrough, real gate approval and durable Accept", {
	skip: !existsSync(chrome), timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-phase1-"));
	const directory = join(root, "permissions");
	const broker = await createPermissionBroker(directory);
	const now = Date.now();
	const base = { pid: process.pid, startedAt: now - 60_000, lastActivity: now - 1000, cwd: "/work/project", model: "test", status: "idle" };
	let sessions: HubSession[] = [
		{ ...base, id: "question", name: "Question", todos: { total: 2, completed: 1, current: "Choose a threshold", tasks: [{ id: 1, subject: "Measure", status: "completed" }, { id: 2, subject: "Choose a threshold", status: "pending" }] } },
		{ ...base, id: "worker", name: "generated-alias", runtimeFallbackAlias: true, cwd: "/work/worker", status: "tool:read", contextPct: 42 },
		{ ...base, id: "review", name: "generated-alias", runtimeFallbackAlias: true, todos: { total: 1, completed: 1, current: "Finish result", tasks: [{ id: 1, subject: "Finish result", status: "completed" }] } },
	];
	const listeners = new Set<() => void>();
	const inspected = new Set<string>();
	const decisions = [];
	const source = { snapshot: () => ({ connected: true, sessions }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, resolveSession: async id => sessions.find(s => s.id === id) };
	const options = { token, source, stateFile: join(root, "session.json"), focus: async () => {}, permissions: {
		inspect: async (owner, id) => { const result = await inspectPermission(owner, id, directory); inspected.add(id); return result; },
		decide: (owner, id, decision) => decidePermission(owner, id, decision, directory),
	} };
	let hub = await startHubServer(options);
	t.after(async () => { await hub.close(); await broker.close(); await rm(root, { recursive: true, force: true }); });
	const publish = () => { for (const listener of listeners) listener(); };
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor('document.querySelectorAll(".session-item").length === 3');
	assert.equal(await browser.evaluate(`${card("question")}.parentElement.id`), "needs-list");
	assert.equal(await browser.evaluate(`${card("worker")}.parentElement.id`), "working-list");
	assert.equal(await browser.evaluate(`${card("review")}.parentElement.id`), "review-list");
	assert.equal(await browser.evaluate(`${card("review")}.querySelector("h2").textContent`), "Finish result");
	assert.equal(await browser.evaluate(`${card("worker")}.querySelector("h2").textContent`), "worker");
	assert.equal(await browser.evaluate('document.querySelector("#live-mode").checked'), false);
	assert.equal(await browser.evaluate(`${card("question")}.querySelector(".reply-unavailable").disabled`), true);
	if (process.env.PI_HUB_SCREENSHOT) {
		const { data } = await browser.call("Page.captureScreenshot", { format: "png" });
		assert.equal(typeof data, "string");
		await writeFile(process.env.PI_HUB_SCREENSHOT, Buffer.from(String(data), "base64"));
	}
	await browser.evaluate(`window.questionCard = ${card("question")}; window.questionRow = window.questionCard.querySelector(".todo-list li"); window.reviewCard = ${card("review")}; window.questionCard.querySelector(".focus").focus()`);

	// Low-risk gates and ordinary status changes stay pending, without DOM movement.
	sessions = sessions.map(s => s.id === "question" ? { ...s, status: "thinking", lastActivity: now + 10 } : s);
	const worker = sessions.find(s => s.id === "worker")!;
	const low = broker.request(worker, { title: "Run tests", description: "$ pnpm test", toolName: "bash", input: JSON.stringify({ command: "pnpm test" }), cwd: worker.cwd }, value => decisions.push(["low", value]));
	await low.ready;
	sessions = sessions.map(s => s.id === "worker" ? { ...s, permissions: [{ id: low.id, title: "Run tests" }] } : s);
	publish();
	await browser.waitFor('Number(document.querySelector("#refresh").dataset.changes) === 2');
	assert.equal(await browser.evaluate(`${card("question")}.parentElement.id`), "needs-list");
	assert.equal(await browser.evaluate(`${card("worker")}.parentElement.id`), "working-list");
	assert.equal(await browser.evaluate('document.activeElement === window.questionCard.querySelector(".focus")'), true);

	const review = sessions.find(s => s.id === "review")!;
	const high = broker.request(review, { title: "Push code", description: "$ git push", toolName: "bash", input: JSON.stringify({ command: "git push" }), cwd: review.cwd }, value => decisions.push(["high", value]));
	await high.ready;
	sessions = sessions.map(s => s.id === "review" ? { ...s, permissions: [{ id: high.id, title: "Push code" }] } : s);
	publish();
	await browser.waitFor(`${card("review")}.parentElement.id === "needs-list" && !${card("review")}.querySelector('[data-decision="once"]').disabled`);
	assert.ok(inspected.has(low.id));
	assert.equal(await browser.evaluate(`${card("worker")}.parentElement.id`), "working-list", "low risk must not break the freeze");
	assert.equal(await browser.evaluate(`${card("question")}.dataset.bucket`), "NEEDS_YOU", "high risk must not flush unrelated pending statuses");
	assert.equal(await browser.evaluate(`${card("review")} === window.reviewCard`), true, "bucket changes move the same DOM node");
	assert.equal(await browser.evaluate('window.questionCard.querySelector(".todo-list li") === window.questionRow'), true, "unchanged todo rows are not rebuilt");
	assert.equal(await browser.evaluate(`${card("review")}.querySelector(".risk").textContent`), "High risk");
	assert.deepEqual(decisions, [], "risk inspection is never approval");

	await browser.evaluate(`${card("review")}.querySelector('[data-decision="once"]').click()`);
	await browser.waitFor(`${card("review")}.dataset.bucket === "REVIEW"`);
	assert.deepEqual(decisions, [["high", "once"]], "browser approval reaches the actual waiting permission owner");
	assert.equal(await browser.evaluate(`${card("question")}.dataset.bucket`), "WORKING", "acting on a card applies pending changes");
	await browser.evaluate(`${card("review")}.querySelector(".ack").click()`);
	await browser.waitFor(`${card("review")}.parentElement.id === "parked-list"`);
	assert.equal(JSON.parse(await readFile(options.stateFile, "utf8")).acks.review, review.lastActivity);

	// New ordinary updates still freeze; the manual badge and Live both apply them.
	low.decide("reject");
	sessions = sessions.map(s => s.id === "worker" ? { ...s, permissions: [], status: "idle", lastActivity: now + 20 } : s.id === "review" ? { ...s, permissions: [] } : s);
	publish();
	await browser.waitFor('Number(document.querySelector("#refresh").dataset.changes) > 0');
	await browser.evaluate('document.querySelector("#refresh").click()');
	await browser.waitFor(`${card("worker")}.dataset.bucket === "REVIEW"`);
	await browser.evaluate('document.querySelector("#live-mode").click()');
	sessions = sessions.map(s => s.id === "worker" ? { ...s, status: "thinking", lastActivity: now + 30 } : s);
	publish();
	await browser.waitFor(`${card("worker")}.dataset.bucket === "WORKING"`);
	assert.equal(await browser.evaluate('document.querySelector("#refresh").textContent'), "Live updates · refresh");
	await hub.close();
	hub = await startHubServer(options);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor(`${card("review")}?.dataset.bucket === "PARKED"`);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
	assert.deepEqual(browser.exceptions, []);
});

test("Parked archive and search operate on the displayed board; cadence applies pending data", { skip: !existsSync(chrome), timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-archive-"));
	const at = Date.now() - 73 * 3600_000;
	const stateFile = join(root, "session.json"); await writeFile(stateFile, JSON.stringify({ acks: { old: at } }));
	let sessions: HubSession[] = [{ id: "old", name: "Old session", cwd: "/old", model: "test", pid: 2, startedAt: at - 1000, lastActivity: at, status: "idle" }];
	const listeners = new Set<() => void>();
	const hub = await startHubServer({ token, stateFile, focus: async () => {}, source: { snapshot: () => ({ connected: true, sessions }), subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, resolveSession: async id => sessions.find(s => s.id === id) } });
	t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor(`${card("old")}?.parentElement.id === "archive-list"`);
	assert.equal(await browser.evaluate('document.querySelector("#archive").open'), false);
	sessions = [{ ...sessions[0], status: "thinking", lastActivity: Date.now() }]; for (const listener of listeners) listener();
	await browser.waitFor('document.querySelector("#refresh").dataset.changes === "1"');
	assert.equal(await browser.evaluate(`${card("old")}.parentElement.id`), "archive-list");
	await browser.evaluate('window.realNow = Date.now; const next = Date.now() + 25 * 60 * 1000 + 1000; Date.now = () => next');
	await browser.waitFor(`${card("old")}.parentElement.id === "working-list"`);
	await browser.evaluate('Date.now = window.realNow; document.querySelector("#search").value = "missing"; document.querySelector("#search").dispatchEvent(new Event("input"))');
	assert.equal(await browser.evaluate('document.querySelectorAll(".card:not([hidden])").length'), 0);
	assert.deepEqual(browser.exceptions, []);
});
