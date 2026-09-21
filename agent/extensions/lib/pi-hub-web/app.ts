import { renderTodos } from "./todos.js";
import { renderPermissions, disposePermissions } from "./permissions.js";
import { ARCHIVE_MS, BUCKETS, CheckinBoard, bucketOf, changedSessions, compareSessions } from "./board.js";
import type { PermissionDecision, PermissionRequest } from "../hub-permissions.ts";
import type { HubSession, HubSnapshot } from "../pi-hub-web-server.ts";

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`Missing Hub element: ${selector}`);
	return element;
};
const board = new CheckinBoard();
const search = $<HTMLInputElement>("#search");
const cards = new Map<string, { card: HTMLElement; session: HubSession; signature?: string; todos?: string }>();
const lists = { NEEDS_YOU: $("#needs-list"), REVIEW: $("#review-list"), WORKING: $("#working-list"), PARKED: $("#parked-list") };
let online = false;
let focusing = false;
let stopped = false;
let token = "";
let controller: AbortController | undefined;
const acknowledging = new Set<string>();

function showNotice(message: string): void { $("#notice").textContent = message; $("#notice").hidden = !message; }
function setConnection(label: string, live = false): void { $("#connection").textContent = label; $("#connection").classList.toggle("live", live); }
function text(card: HTMLElement, selector: string, value: string): void {
	const element = card.querySelector<HTMLElement>(selector)!;
	if (element.textContent !== value) element.textContent = value;
}
function age(timestamp: number | null | undefined): string {
	if (timestamp == null || !Number.isFinite(timestamp)) return "unknown";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86400)}d`;
}
function applyPending(): void { board.apply(); render(); }

async function post(path: string, body: { id: string; requestId?: string; decision?: PermissionDecision; lastAgentEnd?: number | null }, signal?: AbortSignal) {
	const response = await fetch(path, { method: "POST", headers: {
		Authorization: `Bearer ${token}`, "Content-Type": "application/json",
	}, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
	const result = await response.json();
	if (result.snapshot) { board.receive(result.snapshot); applyPending(); }
	if (!response.ok) throw new Error(result.error || "Hub action failed");
	return result;
}

async function focusSession(id: string): Promise<void> {
	if (focusing || !online || !board.pending.connected) return;
	applyPending(); focusing = true; showNotice(""); updateAvailability();
	try { await post("/api/focus", { id }); }
	catch (error) { showNotice(error instanceof Error ? error.message : "Could not focus session"); }
	finally { focusing = false; updateAvailability(); }
}

async function acknowledge(id: string): Promise<void> {
	const session = cards.get(id)?.session;
	if (!session || acknowledging.has(id) || !online || !board.pending.connected) return;
	// Capture what the person actually saw before applying the pending snapshot.
	const lastAgentEnd = session.lastAgentEnd;
	applyPending(); acknowledging.add(id); showNotice(""); updateAvailability();
	try { await post("/api/ack", { id, lastAgentEnd }); }
	catch (error) { showNotice(error instanceof Error ? error.message : "Could not accept result"); }
	finally { acknowledging.delete(id); updateAvailability(); }
}

async function permissionAction(id: string, requestId: string, signal: AbortSignal, decision?: PermissionDecision): Promise<{ permission?: PermissionRequest }> {
	if (!online || !board.pending.connected) throw new Error("Dashboard is disconnected. Use the terminal.");
	if (decision) applyPending();
	const live = board.pending.sessions.find(session => session.id === id);
	if (!live?.permissions?.some(item => item.id === requestId)) throw new Error("Request is no longer pending. Refresh the board.");
	return post(`/api/permissions/${decision ? "decision" : "inspect"}`, { id, requestId, decision }, signal);
}

function updateAvailability(): void {
	for (const [id, view] of cards) {
		const live = board.pending.sessions.find(session => session.id === id);
		const available = online && board.pending.connected && Boolean(live);
		view.card.querySelector<HTMLButtonElement>(".focus")!.disabled = !available || focusing;
		view.card.querySelector<HTMLButtonElement>(".ack")!.disabled = !available || acknowledging.has(id)
			|| live?.lastAgentEnd !== view.session.lastAgentEnd || Boolean(live?.permissions?.length) || live?.bucket === "WORKING";
		renderPermissions(view.card, view.session.permissions ?? [], {
			enabled: available && live?.pid === view.session.pid && (view.session.permissions ?? []).every(item => live?.permissions?.some(current => current.id === item.id)),
			inspect: async (requestId, signal) => (await permissionAction(id, requestId, signal)).permission!,
			decide: async (requestId, decision, signal) => { await permissionAction(id, requestId, signal, decision); },
		});
	}
}

function updateClock(): void {
	for (const { card, session } of cards.values()) {
		const bucket = bucketOf(session);
		text(card, ".state-age", bucket === "NEEDS_YOU" ? `waiting ${age(session.waitingSince)}`
			: bucket === "REVIEW" ? `done ${age(session.lastAgentEnd)} ago`
				: bucket === "PARKED" ? `idle ${age(session.lastAgentEnd ?? session.startedAt)}` : `active ${age(session.lastActivity)} ago`);
		text(card, ".age", `Active ${age(session.lastActivity)} ago`);
	}
	const waits = board.displayed.sessions.filter(session => bucketOf(session) === "NEEDS_YOU" && session.waitingSince != null).map(session => session.waitingSince!);
	$("#longest").textContent = waits.length ? `· longest ${age(Math.min(...waits))}` : "";
	const changes = changedSessions(board.displayed, board.pending);
	const since = new Date(board.appliedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	const minutes = Math.max(1, Math.ceil((board.nextCheckin - Date.now()) / 60_000));
	$("#refresh").textContent = board.live ? "Live updates · refresh" : changes
		? `${changes} changes since ${since} · refresh` : `Up to date · next check-in ${minutes}m · refresh`;
	$("#refresh").dataset.changes = String(changes);
}

function createCard(session: HubSession) {
	const card = $<HTMLTemplateElement>("#session-card").content.firstElementChild!.cloneNode(true) as HTMLElement;
	card.dataset.sessionId = session.id;
	card.querySelector(".focus")!.addEventListener("click", () => void focusSession(session.id));
	card.querySelector(".ack")!.addEventListener("click", () => void acknowledge(session.id));
	card.addEventListener("click", event => { if ((event.target as HTMLElement).closest("summary")) applyPending(); });
	const view = { card, session, signature: undefined as string | undefined, todos: undefined as string | undefined };
	cards.set(session.id, view);
	return view;
}

function paint(view: ReturnType<typeof createCard>, session: HubSession): void {
	view.session = session;
	const signature = JSON.stringify(session);
	if (view.signature === signature) return;
	view.signature = signature;
	const { card } = view;
	const bucket = bucketOf(session);
	const reentry = bucket === "NEEDS_YOU" && session.reason !== "permission";
	const review = bucket === "REVIEW";
	card.dataset.bucket = bucket;
	card.classList.toggle("session-row", bucket === "WORKING" || bucket === "PARKED");
	card.classList.toggle("busy", bucket === "WORKING");
	card.classList.toggle("permission-needed", session.reason === "permission");
	text(card, "h2", session.displayName || session.name || session.id.slice(0, 8));
	text(card, ".short-id", session.id.slice(0, 8));
	text(card, ".project", session.cwd);
	text(card, ".model", session.model);
	text(card, ".activity", session.reason === "permission" ? "Permission needed"
		: reentry ? session.reason === "error" ? "Error" : session.reason === "prompt" ? "Waiting for input" : "Question · inferred"
			: review ? "Ready for review" : bucket === "WORKING" ? session.status || "Working" : "Parked");
	const risk = card.querySelector<HTMLElement>(".risk")!;
	risk.hidden = session.reason !== "permission";
	risk.dataset.risk = session.risk ?? "unknown";
	text(card, ".risk", session.risk ? `${session.risk === "high" ? "High" : "Low"} risk` : "Checking risk…");
	text(card, ".todo-progress", session.todos ? `Todos ${session.todos.completed}/${session.todos.total}` : "Todos unknown");
	text(card, ".current-task", session.todos?.current ? `▸ ${session.todos.current}` : "");
	card.querySelector<HTMLElement>(".current-task")!.hidden = bucket !== "WORKING" || !session.todos?.current;
	const percent = Number.isFinite(session.contextPct) ? Math.max(0, Math.min(100, session.contextPct!)) : null;
	text(card, ".context-label", percent === null ? "unknown" : `${percent}%`);
	card.querySelector("meter")!.value = percent ?? 0;
	card.querySelector<HTMLElement>(".reentry")!.hidden = !reentry;
	text(card, ".goal", session.displayName || session.cwd);
	text(card, ".done", session.todos ? `${session.todos.completed} of ${session.todos.total} todos completed.` : "No task progress published.");
	text(card, ".needs", session.reason === "error" ? "Error details are unavailable in Phase 1. Open the terminal."
		: session.reason === "prompt" ? "Prompt details are unavailable in Phase 1. Open the terminal."
			: `Returned with open todos${session.todos?.current ? `: ${session.todos.current}` : ""}. Open the terminal for the actual question.`);
	card.querySelector<HTMLElement>(".permission-caption")!.hidden = session.reason !== "permission";
	card.querySelector<HTMLButtonElement>(".ack")!.hidden = !review;
	card.querySelector<HTMLButtonElement>(".reply-unavailable")!.hidden = !(review || reentry);
	text(card, ".reply-unavailable", review ? "Send back with a note · Phase 3" : session.reason === "error" ? "Retry in terminal" : "Reply in terminal");
	text(card, ".focus", bucket === "PARKED" ? "Resume" : "Open terminal ↗");
	const list = card.querySelector<HTMLElement>(".completed-todos")!;
	list.hidden = !review;
	const todos = JSON.stringify(session.todos ?? null);
	if (todos !== view.todos) {
		view.todos = todos;
		renderTodos(card, session.todos);
		const rows = (session.todos?.tasks ?? []).filter(task => task.status === "completed").map(task => {
			const row = document.createElement("li"); row.textContent = task.subject; return row;
		});
		list.replaceChildren(...rows);
	}
}

function render(): void {
	const sessions = [...board.displayed.sessions].sort(compareSessions);
	const ids = new Set(sessions.map(session => session.id));
	for (const [id, view] of cards) if (!ids.has(id)) { disposePermissions(view.card); view.card.remove(); cards.delete(id); }
	const query = search.value.toLowerCase();
	const groups = new Map<HTMLElement, HTMLElement[]>();
	const focused = document.activeElement;
	let visible = 0;
	let archived = 0;
	for (const session of sessions) {
		const view = cards.get(session.id) ?? createCard(session);
		paint(view, session);
		view.card.hidden = ![session.displayName, session.name, session.cwd, session.model, session.status, session.bucket, session.reason].join(" ").toLowerCase().includes(query);
		if (!view.card.hidden) visible++;
		const bucket = bucketOf(session);
		const old = bucket === "PARKED" && board.appliedAt - (session.lastAgentEnd ?? session.startedAt) > ARCHIVE_MS;
		if (old && !view.card.hidden) archived++;
		const destination = old ? $("#archive-list") : lists[bucket];
		groups.set(destination, [...(groups.get(destination) ?? []), view.card]);
	}
	for (const [parent, children] of groups) children.forEach((card, index) => {
		if (parent.children[index] !== card) parent.insertBefore(card, parent.children[index] ?? null);
	});
	if (focused instanceof HTMLElement && document.activeElement !== focused && document.contains(focused)) focused.focus();
	for (const [index, selector] of ["#needs-count", "#review-count", "#working-count", "#parked-count"].entries()) {
		$(selector).textContent = String(sessions.filter(session => bucketOf(session) === BUCKETS[index]).length);
	}
	$("#count").textContent = String(sessions.length);
	$("#active-count").textContent = `· ${sessions.filter(session => bucketOf(session) !== "PARKED").length} open threads`;
	$("#archive-count").textContent = `(${archived})`;
	$("#archive").hidden = archived === 0;
	$("#needs-empty").hidden = Boolean(lists.NEEDS_YOU.querySelector(".card:not([hidden])"));
	$("#review-empty").hidden = Boolean(lists.REVIEW.querySelector(".card:not([hidden])"));
	$("#empty").hidden = visible > 0;
	$("#empty").textContent = online ? board.pending.connected ? sessions.length ? "No matching sessions." : "No connected Pi sessions. Start Pi with Intercom enabled."
		: "Waiting for Intercom…" : "Reconnecting to the dashboard…";
	updateAvailability(); updateClock();
}

async function stream(): Promise<void> {
	while (!stopped) {
		controller = new AbortController();
		try {
			const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
			if (response.status === 401 || response.status === 403) { showNotice("Access expired. Run /hub-web in Pi to reopen this dashboard."); stopped = true; return; }
			if (!response.ok || !response.body) throw new Error("Dashboard unavailable");
			const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
			while (!stopped) {
				const { done, value } = await reader.read(); if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let boundary;
				while ((boundary = buffer.indexOf("\n\n")) >= 0) {
					const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
					if (!frame.startsWith("data: ")) continue;
					const snapshot: HubSnapshot = JSON.parse(frame.slice(6));
					online = true;
					setConnection(snapshot.connected ? "● Live · local" : "Connecting to Intercom…", snapshot.connected);
					if (board.receive(snapshot)) render(); else { updateAvailability(); updateClock(); }
				}
			}
		} catch { /* Reconnect without a toast storm; retain the frozen view. */ }
		finally { controller.abort(); online = false; setConnection(stopped ? "Disconnected" : "Reconnecting…"); updateAvailability(); }
		if (!stopped) await new Promise(resolve => setTimeout(resolve, 1500));
	}
}

search.addEventListener("input", render);
$("#refresh").addEventListener("click", applyPending);
$<HTMLInputElement>("#live-mode").addEventListener("change", event => {
	board.setLive((event.target as HTMLInputElement).checked); render();
});
const clock = setInterval(() => { if (board.tick()) render(); else updateClock(); }, 1000);
window.addEventListener("pagehide", () => { stopped = true; controller?.abort(); clearInterval(clock); for (const view of cards.values()) disposePermissions(view.card); });
window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
try {
	const fragment = location.hash.slice(1);
	if (/^[a-f0-9]{64}$/.test(fragment)) sessionStorage.setItem("pi-hub-token", fragment);
	history.replaceState(null, "", "/"); token = sessionStorage.getItem("pi-hub-token") || "";
	if (token) void stream();
	else { setConnection("Not connected"); showNotice("Run /hub-web inside Pi to open your dashboard."); }
} catch { setConnection("Not connected"); showNotice("Browser session storage is unavailable. Allow it, then reopen with /hub-web."); }
