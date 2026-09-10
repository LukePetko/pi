import type { PermissionDecision, PermissionRequest, PermissionSummary } from "../hub-permissions.ts";

export interface PermissionActions {
	enabled: boolean;
	inspect(id: string, signal: AbortSignal): Promise<PermissionRequest>;
	decide(id: string, decision: PermissionDecision, signal: AbortSignal): Promise<void>;
}
interface View {
	root: HTMLElement;
	message: HTMLElement;
	buttons: HTMLButtonElement[];
	controller: AbortController;
	actions: PermissionActions;
	loaded: boolean;
	submitting: boolean;
	finished: boolean;
}
const views = new WeakMap<HTMLElement, Map<string, View>>();

function updateButtons(view: View): void {
	for (const button of view.buttons) button.disabled = !view.actions.enabled || !view.loaded || view.submitting || view.finished;
}

async function decide(view: View, id: string, decision: PermissionDecision): Promise<void> {
	if (!view.actions.enabled || !view.loaded || view.submitting || view.finished) return;
	view.submitting = true;
	view.message.textContent = "Sending decision…";
	updateButtons(view);
	try {
		await view.actions.decide(id, decision, view.controller.signal);
		view.finished = true;
		view.message.textContent = decision === "once" ? "Allowed once" : "Rejected";
	} catch (error) {
		if (!view.controller.signal.aborted) view.message.textContent = error instanceof Error ? error.message : "Decision failed. Use the terminal.";
	} finally { view.submitting = false; updateButtons(view); }
}

function createView(card: HTMLElement, request: PermissionSummary, actions: PermissionActions): View {
	const root = document.createElement("section");
	root.className = "permission-request";
	const heading = document.createElement("h3");
	heading.textContent = request.title;
	const details = document.createElement("div");
	details.className = "permission-details";
	const controls = document.createElement("div");
	controls.className = "permission-actions";
	const message = document.createElement("p");
	message.className = "permission-message";
	message.setAttribute("role", "status");
	message.textContent = "Loading full request…";
	const view: View = { root, message, buttons: [], controller: new AbortController(), actions, loaded: false, submitting: false, finished: false };
	for (const [decision, label] of [["once", "Allow once"], ["reject", "Reject"]] as const) {
		const button = document.createElement("button");
		button.type = "button";
		button.dataset.decision = decision;
		button.textContent = label;
		button.addEventListener("click", () => void decide(view, request.id, decision));
		controls.append(button);
		view.buttons.push(button);
	}
	root.append(heading, details, controls, message);
	card.insertBefore(root, card.querySelector(".card-bottom"));
	updateButtons(view);
	void actions.inspect(request.id, view.controller.signal).then((full) => {
		if (view.controller.signal.aborted) return;
		if (full.id !== request.id) throw new Error("Permission request changed. Refresh the dashboard.");
		const context = document.createElement("p");
		context.className = "permission-context";
		context.textContent = `${full.toolName ? `${full.toolName} · ` : ""}${full.cwd}`;
		const description = document.createElement("pre");
		description.textContent = full.description;
		details.append(context, description);
		if (full.input !== undefined) {
			const label = document.createElement("p");
			label.textContent = "Full tool input";
			const input = document.createElement("pre");
			input.className = "permission-input";
			input.textContent = full.input;
			details.append(label, input);
		}
		view.loaded = true;
		view.message.textContent = "Waiting for your decision";
		updateButtons(view);
	}).catch((error) => {
		if (!view.controller.signal.aborted) view.message.textContent = error instanceof Error ? error.message : "Request unavailable. Use the terminal.";
	});
	return view;
}

export function renderPermissions(card: HTMLElement, pending: PermissionSummary[], actions: PermissionActions): void {
	let entries = views.get(card);
	if (!entries) { entries = new Map(); views.set(card, entries); }
	for (const [id, view] of entries) {
		if (!pending.some((request) => request.id === id)) {
			view.controller.abort(); view.root.remove(); entries.delete(id);
		}
	}
	for (const request of pending) {
		const view = entries.get(request.id) ?? createView(card, request, actions);
		view.actions = actions;
		updateButtons(view);
		entries.set(request.id, view);
	}
}

export function disposePermissions(card: HTMLElement): void {
	for (const view of views.get(card)?.values() ?? []) view.controller.abort();
	views.delete(card);
}
