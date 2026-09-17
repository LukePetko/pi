export const PERMISSION_REQUESTED = "pi:permission-requested";
export const PERMISSION_RESOLVED = "pi:permission-resolved";

export interface PermissionNotice {
	id: string;
	cwd: string;
	title: string;
	broker?: {
		session: { id: string; pid: number };
		requestId: string;
		directory: string;
	};
}

type EventSource = {
	on(channel: string, handler: (data: unknown) => void): () => void;
};

export type ShowNotice = (
	notice: PermissionNotice,
	group: string,
	delivered: () => void,
) => () => void;

type PendingNotice = {
	resolved: boolean;
	remove?: () => void;
};

function noticeId(data: unknown): string | undefined {
	if (!data || typeof data !== "object" || !("id" in data)) return;
	return typeof data.id === "string" && data.id ? data.id : undefined;
}

function removeNotice(state: PendingNotice): void {
	try { state.remove?.(); }
	catch { /* Cleanup is best-effort and must not interrupt a decision or shutdown. */ }
}

/** Only permission events create alerts; generic UI prompts do not. */
export function watchPermissionNotifications(
	events: EventSource,
	show: ShowNotice,
): () => void {
	const pending = new Map<string, PendingNotice>();
	function resolve(id: string): void {
		const state = pending.get(id);
		if (!state) return;
		pending.delete(id);
		state.resolved = true;
		removeNotice(state);
	}
	const stopRequested = events.on(PERMISSION_REQUESTED, (data) => {
		const id = noticeId(data);
		if (!id || pending.has(id)) return;
		const notice = data as PermissionNotice;
		if (typeof notice.cwd !== "string" || typeof notice.title !== "string") return;
		const state: PendingNotice = { resolved: false };
		pending.set(id, state);
		try {
			state.remove = show(notice, `pi-permission:${process.pid}:${id}`, () => {
				// Delivery can finish after approval/dismissal or session shutdown.
				if (state.resolved) removeNotice(state);
			});
			if (state.resolved) removeNotice(state);
		} catch {
			pending.delete(id);
			// Notification failures must never interfere with the permission dialog.
		}
	});
	const stopResolved = events.on(PERMISSION_RESOLVED, (data) => {
		const id = noticeId(data);
		if (id) resolve(id);
	});
	return () => {
		stopRequested();
		stopResolved();
		for (const id of pending.keys()) resolve(id);
	};
}
