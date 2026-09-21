import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";
import { openTestBrowser } from "./lib/hub-browser.ts";

const chrome = process.env.PI_HUB_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("browser renders live cards safely, filters, focuses, and fits mobile", { skip: !existsSync(chrome), timeout: 30_000 }, async (t) => {
	const token = "b".repeat(64);
	let state = {
		connected: true,
		sessions: [
			{ id: "billing", name: "Billing API", cwd: "~/projects/billing", model: "GPT-5.4 · high", pid: 1234, startedAt: Date.now() - 120_000, status: "thinking", contextPct: 42, lastActivity: Date.now() - 20_000 },
			{ id: "design", name: "Design review", cwd: "~/projects/frontend", model: "Claude Opus", pid: 2345, startedAt: Date.now() - 120_000, status: "idle", contextPct: 18, lastActivity: Date.now() - 60_000 },
			{ id: "xss", name: "<img src=x onerror=window.pwned=true>", cwd: "/safe", model: "test", pid: 3456, startedAt: Date.now() - 120_000, status: "idle", lastActivity: Date.now() },
		],
	};
	const listeners = new Set<() => void>();
	const focused = [];
	const hub = await startHubServer({
		token,
		source: {
			snapshot: () => state,
			subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
			resolveSession: async (id) => state.sessions.find((session) => session.id === id),
		},
		focus: async (pid) => { focused.push(pid); },
	});
	t.after(() => hub.close());
	const browser = await openTestBrowser(t, chrome);
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
	await browser.call("Page.navigate", { url: `${hub.origin}/#${token}` });
	await browser.waitFor('document.querySelectorAll(".card").length === 3');
	await browser.evaluate('document.querySelector("#live-mode").click()');
	assert.equal(await browser.evaluate('document.querySelector("#connection").textContent'), "● Live · local");
	assert.equal(await browser.evaluate("location.hash"), "");
	assert.equal(await browser.evaluate('document.querySelectorAll(".card img").length'), 0);
	assert.equal(await browser.evaluate("window.pwned === undefined"), true);
	assert.equal(await browser.evaluate('getComputedStyle(document.querySelector(\'[data-session-id="billing"] .card-bottom\')).display'), "none", "working rows have no visible action buttons");
	await browser.evaluate('document.querySelector("#search").value = "design"; document.querySelector("#search").dispatchEvent(new Event("input"))');
	assert.equal(await browser.evaluate('document.querySelectorAll(".card:not([hidden])").length'), 1);
	await browser.evaluate('document.querySelector(".card:not([hidden]) button").click()');
	await browser.waitFor('!document.querySelector(".card:not([hidden]) button").disabled');
	assert.deepEqual(focused, [2345]);

	state = { ...state, sessions: state.sessions.filter((session) => session.id !== "xss").map((session) => session.id === "billing" ? { ...session, status: "tool:edit", contextPct: 55 } : session) };
	for (const listener of listeners) listener();
	await browser.waitFor('document.querySelectorAll(".card").length === 2 && document.querySelector(\'[data-session-id="billing"] .context-label\').textContent === "55%"');
	await browser.evaluate('document.querySelector("#search").value = ""; document.querySelector("#search").dispatchEvent(new Event("input"))');
	if (process.env.PI_HUB_SCREENSHOT) {
		const { data } = await browser.call("Page.captureScreenshot", { format: "png" });
		await writeFile(process.env.PI_HUB_SCREENSHOT, Buffer.from(data, "base64"));
	}
	await browser.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	assert.equal(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
	state = { connected: false, sessions: [] };
	for (const listener of listeners) listener();
	await browser.waitFor('document.querySelectorAll(".card").length === 0 && document.querySelector("#connection").textContent.includes("Intercom")');
	assert.deepEqual(browser.exceptions, []);
});
