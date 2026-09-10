import { renderTodos } from "./todos.js";
import type { HubSession, HubSnapshot } from "../pi-hub-web-server.ts";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`Missing Hub element: ${selector}`);
	return element;
};
const grid = $("#sessions");
const connection = $("#connection");
const notice = $("#notice");
const search = $<HTMLInputElement>("#search");
const cards = new Map<string, HTMLElement>();
let snapshot: HubSnapshot = { connected: false, sessions: [] };
let online = false;
let focusing = false;
let stopped = false;
let token = "";
let controller: AbortController | undefined;

function showNotice(message: string): void {
	notice.textContent = message;
	notice.hidden = !message;
}

function setConnection(label: string, live = false): void {
	connection.textContent = label;
	connection.classList.toggle("live", live);
}

function busy(session: HubSession): boolean {
	return /^(thinking|tool:)/.test(session.status ?? "");
}

function age(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (!Number.isFinite(seconds)) return "unknown";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	return `${Math.floor(seconds / 3600)}h`;
}

function updateAges() {
	for (const session of snapshot.sessions) {
		const card = cards.get(session.id);
		if (card) card.querySelector(".age").textContent = `Active ${age(session.lastActivity)} ago`;
	}
}

async function focusSession(id: string): Promise<void> {
	if (focusing || !online) return;
	focusing = true;
	showNotice("");
	render();
	try {
		const response = await fetch("/api/focus", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
			signal: AbortSignal.timeout(20_000),
		});
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || "Could not focus session");
	} catch (error) {
		showNotice(error instanceof Error ? error.message : "Could not focus session");
	} finally {
		focusing = false;
		render();
	}
}

function emptyMessage(sessionCount: number): string {
	if (!online) return "Reconnecting to the dashboard…";
	if (!snapshot.connected) return "Waiting for Intercom…";
	if (sessionCount) return "No matching sessions.";
	return "No connected Pi sessions. Start Pi with Intercom enabled.";
}

function render() {
	const query = search.value.toLowerCase();
	const sessions = [...snapshot.sessions].sort((a, b) => Number(busy(b)) - Number(busy(a)) || (a.name || a.id).localeCompare(b.name || b.id));
	const visible = sessions.filter((s) => [s.name, s.cwd, s.model, s.status].join(" ").toLowerCase().includes(query));
	$("#count").textContent = String(sessions.length);
	$("#active-count").textContent = `${sessions.filter(busy).length} working`;
	for (const [id, card] of cards) {
		if (!sessions.some((session) => session.id === id)) { card.remove(); cards.delete(id); }
	}
	for (const session of sessions) {
		let card = cards.get(session.id);
		if (!card) {
			card = $<HTMLTemplateElement>("#session-card").content.firstElementChild.cloneNode(true) as HTMLElement;
			card.querySelector("button").addEventListener("click", () => void focusSession(session.id));
			cards.set(session.id, card);
			grid.append(card);
		}
		// All broker-provided fields are text, never HTML or executable attributes.
		card.querySelector("h2").textContent = session.name || session.id.slice(0, 8);
		card.querySelector(".project").textContent = session.cwd;
		card.querySelector(".model").textContent = session.model;
		card.querySelector(".activity").textContent = session.status || "unknown";
		card.classList.toggle("busy", busy(session));
		const percent = Number.isFinite(session.contextPct) ? Math.max(0, Math.min(100, session.contextPct)) : null;
		card.querySelector(".context-label").textContent = percent === null ? "unknown" : `${percent}%`;
		card.querySelector("meter").value = percent ?? 0;
		card.querySelector("button").disabled = focusing || !online || !snapshot.connected;
		renderTodos(card, session.todos);
		card.hidden = !visible.includes(session);
	}
	// Reorder only when needed; keep keyboard focus while moving existing cards.
	const focused = document.activeElement;
	sessions.forEach((session, index) => {
		const card = cards.get(session.id);
		if (grid.children[index] !== card) grid.insertBefore(card, grid.children[index] ?? null);
	});
	if (focused instanceof HTMLElement && document.activeElement !== focused && document.contains(focused)) focused.focus();
	$("#empty").hidden = visible.length > 0;
	$("#empty").textContent = emptyMessage(sessions.length);
	updateAges();
}

async function stream(): Promise<void> {
	while (!stopped) {
		controller = new AbortController();
		try {
			const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
			if (response.status === 401 || response.status === 403) {
				showNotice("Access expired. Run /hub-web in Pi to reopen this dashboard.");
				stopped = true;
				return;
			}
			if (!response.ok || !response.body) throw new Error("Dashboard unavailable");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (!stopped) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);
					if (!frame.startsWith("data: ")) continue;
					snapshot = JSON.parse(frame.slice(6));
					online = true;
					setConnection(snapshot.connected ? "● Live · local" : "Connecting to Intercom…", snapshot.connected);
					render();
				}
			}
		} catch { /* Show disconnected state and retry without a toast storm. */ }
		finally {
			controller.abort();
			online = false;
			setConnection(stopped ? "Disconnected" : "Reconnecting…");
			render();
		}
		if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1500));
	}
}

search.addEventListener("input", render);
window.addEventListener("pagehide", () => { stopped = true; controller?.abort(); });
window.addEventListener("pageshow", (event) => {
	// Recreate one stream after bfcache restore, rather than reviving an old loop.
	if (event.persisted) location.reload();
});
setInterval(updateAges, 10_000);
try {
	const fragment = location.hash.slice(1);
	if (/^[a-f0-9]{64}$/.test(fragment)) sessionStorage.setItem("pi-hub-token", fragment);
	history.replaceState(null, "", "/");
	token = sessionStorage.getItem("pi-hub-token") || "";
	if (token) void stream();
	else { setConnection("Not connected"); showNotice("Run /hub-web inside Pi to open your dashboard."); }
} catch {
	setConnection("Not connected");
	showNotice("Browser session storage is unavailable. Allow it, then reopen with /hub-web.");
}
