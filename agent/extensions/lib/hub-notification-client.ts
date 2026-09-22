import { ensureHubWeb, type HubEndpoint } from "./pi-hub-web-launcher.ts";
import { NOTIFICATION_API, type NotificationEvent, type NotificationOrigin } from "./hub-notification-protocol.ts";

/** Bounded in-memory retries use the same event IDs. Never fall back to a second OS sender. */
export function createHubNotificationClient(options: {
	origin: () => Promise<NotificationOrigin>;
	ensure?: () => Promise<HubEndpoint>;
	fetch?: typeof fetch;
	report?: (message: string) => void;
	now?: () => number;
	retryMs?: number;
	rebindMs?: number;
}) {
	const ensure = options.ensure ?? ensureHubWeb;
	const request = options.fetch ?? fetch;
	const now = options.now ?? Date.now;
	const queue: { event: NotificationEvent; time: number }[] = [];
	let busy = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let warned = false;
	let sealed = false;
	let discard = false;
	let binding: NotificationOrigin | undefined;
	async function post(endpoint: HubEndpoint, route: string, value: unknown) {
		const response = await request(`${endpoint.origin}${NOTIFICATION_API}${route}`, {
			method: "POST", headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(value), signal: AbortSignal.timeout(3000), redirect: "error",
		});
		if (!response.ok) throw new Error(`Hub notifications unavailable (${response.status})`);
	}
	async function flush() {
		if (busy || discard) return;
		busy = true;
		clearTimeout(timer); timer = undefined;
		try {
			while (queue.length && queue[0].time < now() - 300000) queue.shift();
			if (!queue.length && sealed) return;
			const endpoint = await ensure(); // Honors sticky stopped intent.
			if (!endpoint.capabilities?.includes("notifications-v1")) throw new Error("Restart Hub to enable resident notifications");
			if (binding) {
				// Cleanup uses the last known owned runtime, never a fresh grant of authority.
				// It must still reach Hub after Intercom/its originating process disconnects.
				for (const item of queue.filter(item => ["session-ended", "permission-resolved"].includes(item.event.kind))) {
					if (discard) return;
					if (item.time >= now() - 300000) await post(endpoint, "event", { ...item.event, bindingSequence: binding.bindingSequence });
					const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1);
				}
				if (!queue.length && sealed) return;
			}
			binding = await options.origin();
			await post(endpoint, "register", binding);
			while (!discard && queue.length) {
				const item = queue[0];
				if (item.time >= now() - 300000) await post(endpoint, "event", { ...item.event, generation: binding.generation, bindingSequence: binding.bindingSequence });
				if (queue[0] === item) queue.shift();
			}
		} catch (error: any) {
			if (!warned) { warned = true; (options.report ?? console.error)(`${error.message}; local Pi permission UI is unchanged`); }
		} finally {
			busy = false;
			if (queue.length && !discard) {
				timer = setTimeout(() => { void flush(); }, options.retryMs ?? 2000); timer.unref();
			}
		}
	}
	const heartbeat = setInterval(() => { if (!sealed) void flush(); }, options.rebindMs ?? 10000);
	heartbeat.unref();
	return {
		send(event: NotificationEvent) {
			if (sealed || discard) return;
			// Shutdown supersedes all undelivered presentation events and must never be
			// stranded by saturation. An in-flight request is followed by this revoke.
			if (event.kind === "session-ended") queue.length = 0;
			if (event.kind === "permission-resolved" && queue.length >= 64) {
				const obsolete = queue.findIndex(item => item.event.kind === "completion" || item.event.kind === "permission-requested");
				if (obsolete >= 0) queue.splice(obsolete, 1);
			}
			if (queue.length >= 64) {
				(options.report ?? console.error)("Hub notification retry queue full; local Pi UI is unchanged");
				return;
			}
			queue.push({ event, time: now() });
			if (event.kind === "session-ended") { sealed = true; clearInterval(heartbeat); }
			void flush();
		},
		flush,
		dispose() { discard = true; queue.length = 0; clearTimeout(timer); clearInterval(heartbeat); },
	};
}
