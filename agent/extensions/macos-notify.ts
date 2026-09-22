import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { IntercomExtensionChannel, IntercomExtensionRegistration } from "../npm/node_modules/pi-intercom/extension-api.ts";
import { processBirth } from "./lib/native-permission-action.ts";
import { createHubNotificationClient } from "./lib/hub-notification-client.ts";
import { PERMISSION_REQUESTED, PERMISSION_RESOLVED, type PermissionNotice } from "./lib/permission-notifications.ts";
import type { NotificationEvent, NotificationOrigin } from "./lib/hub-notification-protocol.ts";

/** Pi owns event timing and local permission UI; only the resident Hub talks to macOS. */
export default function macosNotify(pi: ExtensionAPI, dependencies = {
	client: createHubNotificationClient, birth: processBirth,
}) {
	let channel: IntercomExtensionChannel | undefined;
	let registered = false;
	let disposed = false;
	let current: ReturnType<typeof createHubNotificationClient> | undefined;
	let generation = "";
	let startedAt = 0;
	let unsubscribeEvents: (() => void)[] = [];
	const registration: IntercomExtensionRegistration = {
		namespace: "pi-hub-notifications", ownerEligible: false,
		onReady(value) { channel = value; registered = true; },
	};
	const register = () => {
		if (registered || disposed) return;
		pi.events.emit("intercom:extension-register", registration);
		// The bus does not acknowledge listener presence; only onReady does.
	};
	const unsubscribeReady = pi.events.on("intercom:extension-registry-ready", register);
	register();
	function send(value: Omit<NotificationEvent, "version" | "eventId" | "generation">) {
		current?.send({ ...value, version: 1, eventId: randomUUID(), generation });
	}
	function end() {
		for (const unsubscribe of unsubscribeEvents) unsubscribe();
		unsubscribeEvents = [];
		send({ kind: "session-ended" });
		current = undefined;
	}
	pi.on("session_start", (_event, ctx) => {
		end();
		startedAt = 0;
		generation = randomUUID();
		const origin: NotificationOrigin = {
			pid: process.pid, birth: dependencies.birth(process.pid),
			session: ctx.sessionManager.getSessionId(), generation,
			sequence: process.hrtime.bigint().toString(), bindingSequence: "1",
		};
		if (process.env.TMUX) {
			try { origin.tmuxSocket = realpathSync(process.env.TMUX.split(",").slice(0, -2).join(",")); }
			catch { /* Missing focus context is conservative, never a guessed terminal. */ }
		}
		let id: string | undefined;
		current = dependencies.client({ origin: async () => {
			id ??= process.env.PI_INTERCOM_SESSION_ID;
			if (id || channel) {
				if (!channel?.snapshot().connected) throw new Error("Notification broker binding unavailable");
				const own = (await channel.listSessions()).find(s => s.id === id && s.pid === process.pid);
				if (!own?.endpointEpoch) throw new Error("Notification broker epoch unavailable");
				const next = { id: own.id, startedAt: own.startedAt, endpointEpoch: own.endpointEpoch };
				if (JSON.stringify(next) !== JSON.stringify(origin.broker)) origin.bindingSequence = process.hrtime.bigint().toString();
				origin.broker = next;
			}
			return { ...origin, ...(origin.broker ? { broker: { ...origin.broker } } : {}) };
		} });
		unsubscribeEvents = [
			pi.events.on(PERMISSION_REQUESTED, (data) => {
				const notice = data as PermissionNotice;
				if (!notice?.id || typeof notice.title !== "string" || typeof notice.cwd !== "string") return;
				// Broker paths and callback configuration are never sent over this API.
				if (notice.broker && (notice.broker.session.pid !== origin.pid || notice.broker.session.id !== (id ?? process.env.PI_INTERCOM_SESSION_ID))) return;
				send({ kind: "permission-requested", noticeId: notice.id, requestId: notice.broker?.requestId, cwd: notice.cwd, title: notice.title });
			}),
			pi.events.on(PERMISSION_RESOLVED, (data) => {
				const notice = data as { id?: string };
				if (typeof notice?.id === "string") send({ kind: "permission-resolved", noticeId: notice.id });
			}),
		];
		register();
		void current.flush();
	});
	pi.on("agent_start", () => { startedAt = Date.now(); });
	pi.on("agent_end", (_event, ctx) => {
		send({ kind: "completion", cwd: ctx.cwd, ...(startedAt ? { durationMs: Date.now() - startedAt } : {}) });
		startedAt = 0;
	});
	pi.on("session_shutdown", () => { disposed = true; end(); unsubscribeReady(); });
	pi.registerCommand("notify-test", {
		description: "Test resident Hub notification (suppressed while this Pi is focused)",
		handler: async (_args, ctx) => {
			send({ kind: "completion", cwd: ctx.cwd, test: true });
			ctx.ui.notify("Notification queued for Hub; skipped if stopped or this Pi is focused", "info");
		},
	});
}
