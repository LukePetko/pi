import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import {
	startHubServer,
	type HubSession,
	type HubSnapshot,
} from "../extensions/lib/pi-hub-web-server.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome =
	process.env.PI_HUB_CHROME ||
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function session(id: string, name: string, startedAt: number): HubSession {
	return {
		id,
		name,
		startedAt,
		pid: 1234,
		cwd: "/test",
		model: "test",
		status: "idle",
		lastActivity: Date.now(),
	};
}

test("Hub web keeps chronological card order across live state changes, filtering and reload", {
	skip: !existsSync(chrome),
	timeout: 30_000,
}, async (t) => {
	let oldest = session("oldest", "Alpha", 10);
	let middle = session("middle", "Beta", 20);
	let newest = session("newest", "Gamma", 30);
	let state: HubSnapshot = {
		connected: true,
		sessions: [newest, oldest, middle],
	};
	const listeners = new Set<() => void>();
	const token = "d".repeat(64);
	const hub = await startHubServer({
		token,
		source: {
			snapshot: () => state,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			resolveSession: async (id) => state.sessions.find((item) => item.id === id),
		},
	});
	t.after(() => hub.close());
	const browser = await openTestBrowser(t, chrome);
	function publish(sessions: HubSession[]) {
		state = { connected: true, sessions };
		for (const listener of listeners) listener();
	}
	const names = () =>
		browser.evaluate(
			'Array.from(document.querySelectorAll(".card h2"), node => node.textContent)',
		);
	const unchanged = () =>
		browser.evaluate(
			'window.originalCards.every((card, index) => document.querySelector("#sessions").children[index] === card)',
		);
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor('document.querySelectorAll(".card").length === 3');
	assert.deepEqual(await names(), ["Alpha", "Beta", "Gamma"]);
	await browser.evaluate(
		'window.originalCards = Array.from(document.querySelectorAll(".card")); window.focusedButton = window.originalCards[0].querySelector("button"); window.focusedButton.focus()',
	);

	newest = { ...newest, status: "thinking", lastActivity: Date.now() + 1000 };
	publish([middle, newest, oldest]);
	await browser.waitFor(
		'window.originalCards[2].querySelector(".activity").textContent === "thinking"',
	);
	assert.equal(await unchanged(), true, "thinking must not promote a card");
	assert.equal(
		await browser.evaluate("document.activeElement === window.focusedButton"),
		true,
	);

	middle = {
		...middle,
		permissions: [{ id: "approval", title: "Needs permission" }],
	};
	newest = { ...newest, status: "tool:edit" };
	publish([newest, middle, oldest]);
	await browser.waitFor(
		'window.originalCards[1].querySelector(".activity").textContent === "Permission needed" && window.originalCards[2].querySelector(".activity").textContent === "tool:edit"',
	);
	assert.equal(
		await unchanged(),
		true,
		"permissions and tool activity must not change order",
	);

	oldest = {
		...oldest,
		name: "Zulu renamed",
		status: "thinking",
		lastActivity: Date.now() + 2000,
	};
	middle = { ...middle, permissions: [], status: "idle" };
	newest = { ...newest, status: "idle" };
	publish([middle, oldest, newest]);
	await browser.waitFor(
		'window.originalCards[0].querySelector("h2").textContent === "Zulu renamed" && window.originalCards[1].querySelector(".activity").textContent === "idle"',
	);
	assert.equal(
		await unchanged(),
		true,
		"rename and permission resolution must preserve positions",
	);
	await browser.evaluate(
		'document.querySelector("#search").value = "Beta"; document.querySelector("#search").dispatchEvent(new Event("input"))',
	);
	assert.equal(
		await browser.evaluate(
			'document.querySelectorAll(".card:not([hidden])").length',
		),
		1,
	);
	assert.equal(await unchanged(), true);
	await browser.evaluate(
		'document.querySelector("#search").value = ""; document.querySelector("#search").dispatchEvent(new Event("input"))',
	);

	const tieA = session("tie-a", "Zulu new", 40);
	const tieZ = { ...session("tie-z", "Alpha new", 40), status: "thinking" };
	publish([tieZ, middle, newest, tieA, oldest]);
	await browser.waitFor('document.querySelectorAll(".card").length === 5');
	assert.deepEqual(
		await names(),
		["Zulu renamed", "Beta", "Gamma", "Zulu new", "Alpha new"],
		"new sessions append; equal start times use stable IDs, not names or state",
	);
	assert.equal(await unchanged(), true);
	publish([tieZ, oldest, tieA, newest]);
	await browser.waitFor('document.querySelectorAll(".card").length === 4');
	const remaining = ["Zulu renamed", "Gamma", "Zulu new", "Alpha new"];
	assert.deepEqual(
		await names(),
		remaining,
		"removal preserves survivors' relative order",
	);
	await browser.call("Page.reload");
	await browser.waitFor('document.querySelectorAll(".card").length === 4');
	assert.deepEqual(
		await names(),
		remaining,
		"page reload must not reshuffle the same sessions",
	);
	assert.deepEqual(browser.exceptions, []);
});
