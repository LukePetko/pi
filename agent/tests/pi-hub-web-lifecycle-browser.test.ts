import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifecycle, writeLifecycle } from "../extensions/lib/hub-lifecycle.ts";
import { writeHubTodos } from "../extensions/lib/hub-todos.ts";
import { withHubTodos } from "../extensions/lib/hub-todo-source.ts";
import { startHubServer, type HubSession } from "../extensions/lib/pi-hub-web-server.ts";
import { createPermissionBroker, inspectPermission, decidePermission } from "../extensions/lib/hub-permissions.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome = process.env.PI_HUB_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const card = `document.querySelector('[data-session-id="phase2"]')`;

test("Phase 2: real parked startup, 1s propagation under Live/check-in, prompt priority, reload and real ack stamps", {
	skip: !existsSync(chrome), timeout: 30_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-phase2-browser-"));
	const now = Date.now();
	let session = { id: "phase2", pid: process.pid, startedAt: now, endpointEpoch: "epoch", lastActivity: now + 100, cwd: "/fixture", model: "test", status: "idle" };
	const producer = createLifecycle(now);
	const listeners = new Set<() => void>();
	const source = { snapshot: () => ({ connected: true, sessions: [session] }),
		subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, resolveSession: async () => session };
	const token = "e".repeat(64);
	const stateFile = join(root, "state.json");
	const start = () => startHubServer({ token, stateFile, focus: async () => {},
		source: withHubTodos(source, { directory: root, lifecycleDirectory: root }) }); // actual default 1000 ms poll
	await writeLifecycle(root, session, producer.snapshot());
	await writeHubTodos(root, session, [{ id: 1, subject: "Decide", status: "pending" }]);
	let hub = await start();
	t.after(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor(`${card}?.dataset.bucket === "PARKED"`);
	await browser.evaluate('document.querySelector("#live-mode").click()');
	producer.user(); producer.start();
	await writeLifecycle(root, session, producer.snapshot());
	await browser.waitFor(`${card}.dataset.bucket === "WORKING"`);
	producer.end([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "<img src=x onerror=window.pwned=true> Choose a threshold" }] }] as any);
	// Intercom reports idle at agent_end, but lifecycle remains running until settled.
	for (const listener of listeners) listener();
	assert.equal(await browser.evaluate(`${card}.dataset.bucket`), "WORKING");
	producer.settled();
	const returned = producer.snapshot();
	const sentAt = Date.now();
	await writeLifecycle(root, session, returned);
	await browser.waitFor(`${card}.dataset.bucket === "NEEDS_YOU"`);
	assert.ok(Date.now() - sentAt < 2000, "returned with open todos reaches Live UI within two seconds");
	assert.equal(await browser.evaluate(`${card}.querySelector(".needs").textContent`), returned.lastAssistantText);
	assert.equal(await browser.evaluate(`${card}.querySelectorAll("img").length`), 0);
	assert.match(String(await browser.evaluate(`${card}.querySelector(".state-age").textContent`)), /waiting/i);
	// The server carries the authoritative waiting timestamp, not presence activity.
	const response = await fetch(`${hub.origin}/api/events`, { headers: { Authorization: `Bearer ${token}` } });
	const reader = response.body!.getReader();
	const frame = new TextDecoder().decode((await reader.read()).value);
	await reader.cancel();
	const snapshot = JSON.parse(frame.slice(6).trim());
	assert.equal(snapshot.sessions[0].waitingSince, returned.enteredStateAt);
	assert.equal(snapshot.sessions[0].lastAgentEnd, returned.lastAgentEnd);
	assert.notEqual(snapshot.sessions[0].lastAgentEnd, session.lastActivity);
	// Frozen ordinary updates stay pending until the check-in badge is applied.
	await browser.evaluate('document.querySelector("#live-mode").click()');
	producer.start(); producer.promptStart();
	session = { ...session, status: "tool:read" };
	await writeLifecycle(root, session, producer.snapshot());
	for (const listener of listeners) listener();
	const promptEvents = await fetch(`${hub.origin}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
	const promptReader = promptEvents.body!.getReader();
	let pending = "";
	while (!pending.includes('"turnState":"prompt"')) pending += new TextDecoder().decode((await promptReader.read()).value);
	await promptReader.cancel();
	await browser.waitFor('Number(document.querySelector("#refresh").dataset.changes) > 0');
	await browser.evaluate('document.querySelector("#refresh").click()');
	await browser.waitFor(`${card}.querySelector(".needs").textContent.includes("extension is waiting")`);
	assert.equal(await browser.evaluate(`${card}.dataset.bucket`), "NEEDS_YOU");
	// Reload replays the prompt; a hub restart does not depend on another producer event.
	await hub.close(); hub = await start();
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor(`${card}?.querySelector(".needs").textContent.includes("extension is waiting")`);
	await browser.evaluate('document.querySelector("#live-mode").click()');
	producer.promptEnd(); producer.end([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] as any); producer.settled();
	await writeHubTodos(root, session, [{ id: 1, subject: "Decide", status: "completed" }]);
	await writeLifecycle(root, session, producer.snapshot());
	await browser.waitFor(`${card}.dataset.bucket === "REVIEW"`);
	await browser.evaluate(`${card}.querySelector(".ack").click()`);
	await browser.waitFor(`${card}.dataset.bucket === "PARKED"`);
	assert.equal(JSON.parse(await readFile(stateFile, "utf8")).acks.phase2, producer.snapshot().lastAgentEnd);
	assert.deepEqual(browser.exceptions, []);
});

test("default-frozen permission action follows prompt end for that runtime only", { skip: !existsSync(chrome), timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "hub-phase2-gate-"));
	const broker = await createPermissionBroker(join(root, "permissions"));
	const producer = createLifecycle(); producer.start(); // pre-click lifecycle deliberately lags the UI gate
	let owner: HubSession = { id: "phase2", pid: process.pid, startedAt: Date.now(), endpointEpoch: "epoch", lastActivity: Date.now(), cwd: "/fixture", model: "test", status: "tool:bash", ...producer.snapshot() };
	let other: HubSession = { ...owner, id: "other", ...createLifecycle().snapshot(), status: "idle" };
	const decisions: string[] = [];
	const gate = broker.request(owner, { title: "Run tests", description: "$ pnpm test", toolName: "bash", input: JSON.stringify({ command: "pnpm test" }), cwd: owner.cwd }, (decision) => {
		decisions.push(decision);
		producer.promptStart(); owner = { ...owner, ...producer.snapshot() }; // response catches up to prompt
	});
	await gate.ready;
	owner = { ...owner, permissions: [{ id: gate.id, title: "Run tests" }] };
	const listeners = new Set<() => void>();
	const token = "a".repeat(64);
	const hub = await startHubServer({ token, stateFile: join(root, "state.json"), focus: async () => {}, source: {
		snapshot: () => ({ connected: true, sessions: [owner, other] }), subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
		resolveSession: async (id) => id === owner.id ? owner : other,
	}, permissions: {
		inspect: (session, id) => inspectPermission(session, id, join(root, "permissions")),
		decide: (session, id, decision) => decidePermission(session, id, decision, join(root, "permissions")),
	} });
	t.after(async () => { await hub.close(); await broker.close(); await rm(root, { recursive: true, force: true }); });
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor(`${card}?.querySelector('[data-decision="once"]')?.disabled === false`);
	assert.equal(await browser.evaluate('document.querySelector("#live-mode").checked'), false);
	await browser.evaluate(`${card}.querySelector('[data-decision="once"]').click()`);
	await browser.waitFor(`${card}.querySelector(".needs").textContent.includes("extension is waiting")`);
	assert.deepEqual(decisions, ["once"], "real waiting owner callback, no gate command executed");
	// Deliberately publish prompt_end only AFTER the response, matching async producer/cache propagation.
	producer.promptEnd(); owner = { ...owner, permissions: [], ...producer.snapshot() };
	other = { ...other, turnState: "running" };
	for (const listener of listeners) listener();
	await browser.waitFor(`${card}.dataset.bucket === "WORKING"`);
	assert.equal(await browser.evaluate('document.querySelector(\'[data-session-id="other"]\').dataset.bucket'), "PARKED");
	assert.deepEqual(browser.exceptions, []);
});
