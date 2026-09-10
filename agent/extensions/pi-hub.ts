import { basename } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@mariozechner/pi-tui";
import {
	INTERCOM_EXTENSION_REGISTER_EVENT,
	type IntercomExtensionChannel,
	type IntercomExtensionEvent,
} from "../npm/node_modules/pi-intercom/extension-api.ts";
import type { SessionInfo } from "../npm/node_modules/pi-intercom/types.ts";
import { focusPiSession } from "./lib/pi-hub-navigation.ts";

const NAMESPACE = "pi-hub/v1";
const MAX_VISIBLE_SESSIONS = 8;

type ConnectionState = "waiting" | "connected" | "offline" | "unsupported";

function connectionState(
	connected: boolean,
	supported: boolean,
): ConnectionState {
	if (!connected) return "offline";
	return supported ? "connected" : "unsupported";
}

function statusDotColor(status: string): "warning" | "accent" | "muted" {
	if (status.startsWith("tool:")) return "warning";
	if (status.startsWith("thinking")) return "accent";
	return "muted";
}

type HubSnapshot = {
	connection: ConnectionState;
	error?: string;
	sessions: SessionInfo[];
};

function formatCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

function formatAge(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 5) return "now";
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

function compactPath(cwd: string): string {
	const home = process.env.HOME;
	if (!home) return cwd;
	if (cwd === home) return "~";
	return cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}

function statusRank(status = ""): number {
	if (status.startsWith("tool:")) return 0;
	if (status.startsWith("thinking")) return 1;
	if (status.startsWith("idle")) return 2;
	return 3;
}

function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
	return [...sessions].sort((left, right) => {
		const rank = statusRank(left.status) - statusRank(right.status);
		return rank || right.lastActivity - left.lastActivity;
	});
}

function sessionLabel(session: SessionInfo): string {
	return (
		session.name?.trim() || basename(session.cwd) || session.id.slice(0, 8)
	);
}

function contextLabel(session: SessionInfo): string {
	if (typeof session.contextPct !== "number") return "ctx ?";
	const tokens =
		typeof session.contextTokens === "number"
			? formatCount(session.contextTokens)
			: "?";
	const window =
		typeof session.contextWindow === "number"
			? formatCount(session.contextWindow)
			: "?";
	return `${session.contextPct}% ctx ${tokens}/${window}`;
}

class PiHubOverlay implements Component {
	private offset = 0;
	private selectedId: string | undefined;
	private navigationError: string | undefined;
	private navigating = false;

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly getSnapshot: () => HubSnapshot,
		private readonly refresh: () => Promise<void>,
		private readonly navigate: (session: SessionInfo) => void | Promise<void>,
	) {}

	private selectedSession(sessions: SessionInfo[]): SessionInfo | undefined {
		const selected = sessions.find((session) => session.id === this.selectedId);
		if (selected) return selected;
		this.selectedId = sessions[0]?.id;
		return sessions[0];
	}

	private moveSelection(offset: number): void {
		const sessions = this.getSnapshot().sessions;
		if (!sessions.length) return;
		const selected = this.selectedSession(sessions);
		const current = Math.max(
			0,
			sessions.findIndex((session) => session.id === selected?.id),
		);
		const next = Math.max(0, Math.min(sessions.length - 1, current + offset));
		this.selectedId = sessions[next]?.id;
		if (next < this.offset) this.offset = next;
		if (next >= this.offset + MAX_VISIBLE_SESSIONS) {
			this.offset = next - MAX_VISIBLE_SESSIONS + 1;
		}
		this.tui.requestRender();
	}

	private activateSelection(): void {
		if (this.navigating) return;
		const session = this.selectedSession(this.getSnapshot().sessions);
		if (!session) return;
		this.navigating = true;
		this.navigationError = undefined;
		this.tui.requestRender();
		void Promise.resolve()
			.then(() => this.navigate(session))
			.then(
				() => this.done(),
				(error) => {
					this.navigating = false;
					this.navigationError =
						error instanceof Error ? error.message : String(error);
					this.tui.requestRender();
				},
			);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done();
			return;
		}
		if (data === "r") {
			void this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.activateSelection();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
		}
	}

	render(width: number): string[] {
		const panelWidth = Math.max(4, width);
		const innerWidth = Math.max(1, panelWidth - 4);
		const snapshot = this.getSnapshot();
		const sessions = snapshot.sessions;
		const selected = this.selectedSession(sessions);
		const selectedIndex = sessions.findIndex(
			(session) => session.id === selected?.id,
		);
		const maxOffset = Math.max(0, sessions.length - MAX_VISIBLE_SESSIONS);
		this.offset = Math.min(this.offset, maxOffset);
		if (selectedIndex >= 0 && selectedIndex < this.offset) {
			this.offset = selectedIndex;
		} else if (selectedIndex >= this.offset + MAX_VISIBLE_SESSIONS) {
			this.offset = selectedIndex - MAX_VISIBLE_SESSIONS + 1;
		}
		const visible = sessions.slice(
			this.offset,
			this.offset + MAX_VISIBLE_SESSIONS,
		);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (content = "", highlighted = false) => {
			const clipped = truncateToWidth(content, innerWidth);
			const padding = " ".repeat(
				Math.max(0, innerWidth - visibleWidth(clipped)),
			);
			const body = ` ${clipped}${padding} `;
			return `${border("│")}${highlighted ? this.theme.bg("selectedBg", body) : body}${border("│")}`;
		};
		const separator = `${border("├")}${border("─".repeat(panelWidth - 2))}${border("┤")}`;
		let connectionColor: "success" | "warning" | "error" = "error";
		if (snapshot.connection === "connected") connectionColor = "success";
		else if (snapshot.connection === "waiting") connectionColor = "warning";
		const connectionLabel =
			snapshot.connection === "connected" ? "live" : snapshot.connection;
		const title = `${this.theme.fg("accent", "Pi Hub")} ${this.theme.fg("muted", `· ${sessions.length} session${sessions.length === 1 ? "" : "s"}`)}`;
		const connection = `${this.theme.fg(connectionColor, "●")} ${this.theme.fg("muted", connectionLabel)}`;
		const titleGap = " ".repeat(
			Math.max(1, innerWidth - visibleWidth(title) - visibleWidth(connection)),
		);
		const lines = [
			`${border("╭")}${border("─".repeat(panelWidth - 2))}${border("╮")}`,
			row(`${title}${titleGap}${connection}`),
			separator,
		];

		const visibleError = this.navigationError ?? snapshot.error;
		if (visibleError) {
			lines.push(row(this.theme.fg("error", visibleError)), separator);
		}

		if (!visible.length) {
			lines.push(
				row(
					this.theme.fg(
						"muted",
						snapshot.connection === "connected"
							? "No Pi sessions found."
							: "Waiting for pi-intercom…",
					),
				),
			);
		} else {
			for (const session of visible) {
				const highlighted = session.id === selected?.id;
				const status = session.status || "unknown";
				const active =
					status.startsWith("tool:") || status.startsWith("thinking");
				const dotColor = statusDotColor(status);
				const self =
					session.id === process.env.PI_INTERCOM_SESSION_ID
						? this.theme.fg("muted", " (this)")
						: "";
				const pointer = highlighted ? "›" : " ";
				const heading = `${this.theme.fg("accent", pointer)} ${this.theme.fg(dotColor, active ? "●" : "○")} ${this.theme.fg("text", sessionLabel(session))}${self}`;
				const state = highlighted && this.navigating ? "focusing…" : status;
				const activity = `${this.theme.fg(active ? "accent" : "muted", state)} ${this.theme.fg("dim", `· ${formatAge(session.lastActivity)} ago`)}`;
				const gap = " ".repeat(
					Math.max(
						1,
						innerWidth - visibleWidth(heading) - visibleWidth(activity),
					),
				);
				lines.push(row(`${heading}${gap}${activity}`, highlighted));
				lines.push(
					row(
						this.theme.fg(
							"muted",
							`    ${session.model} · ${compactPath(session.cwd)} · ${contextLabel(session)} · up ${formatAge(session.startedAt)}`,
						),
						highlighted,
					),
				);
			}
		}

		lines.push(separator);
		const range =
			sessions.length > MAX_VISIBLE_SESSIONS
				? ` · ${this.offset + 1}-${Math.min(sessions.length, this.offset + MAX_VISIBLE_SESSIONS)}/${sessions.length}`
				: "";
		lines.push(
			row(
				`${this.theme.fg("text", "enter")} ${this.theme.fg("muted", "focus")}  ${this.theme.fg("text", "j/k")} ${this.theme.fg("muted", "select")}  ${this.theme.fg("text", "r")} ${this.theme.fg("muted", "refresh")}  ${this.theme.fg("text", "q/esc")} ${this.theme.fg("muted", `close${range}`)}`,
			),
		);
		lines.push(
			`${border("╰")}${border("─".repeat(panelWidth - 2))}${border("╯")}`,
		);
		return lines;
	}

	invalidate(): void {}
}

export default function piHub(pi: ExtensionAPI): void {
	let channel: IntercomExtensionChannel | undefined;
	let connection: ConnectionState = "waiting";
	let error: string | undefined;
	let sessions = new Map<string, SessionInfo>();
	let activeTui: { requestRender: () => void } | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	function requestRender(): void {
		activeTui?.requestRender();
	}

	function snapshot(): HubSnapshot {
		return {
			connection,
			...(error ? { error } : {}),
			sessions: sortSessions([...sessions.values()]),
		};
	}

	async function refresh(): Promise<void> {
		const currentChannel = channel;
		const currentGeneration = generation;
		if (!currentChannel) {
			connection = "waiting";
			requestRender();
			return;
		}
		try {
			const listed = await currentChannel.listSessions();
			if (channel !== currentChannel || generation !== currentGeneration)
				return;
			sessions = new Map(listed.map((session) => [session.id, session]));
			const state = currentChannel.snapshot();
			connection = connectionState(state.connected, state.supported);
			error = undefined;
		} catch (caught) {
			if (channel !== currentChannel || generation !== currentGeneration)
				return;
			connection = "offline";
			error = caught instanceof Error ? caught.message : String(caught);
		}
		requestRender();
	}

	function onIntercomEvent(event: IntercomExtensionEvent): void {
		if (event.type === "connection") {
			connection = connectionState(event.connected, event.supported);
			if (event.connected) void refresh();
		} else if (
			event.type === "session_joined" ||
			event.type === "presence_update"
		) {
			sessions.set(event.session.id, event.session);
		} else if (event.type === "session_left") {
			sessions.delete(event.sessionId);
		}
		requestRender();
	}

	pi.on("session_start", () => {
		const sessionGeneration = ++generation;
		pi.events.emit(INTERCOM_EXTENSION_REGISTER_EVENT, {
			namespace: NAMESPACE,
			ownerEligible: false,
			onReady: (readyChannel: IntercomExtensionChannel) => {
				if (generation !== sessionGeneration) return;
				channel = readyChannel;
				void refresh();
			},
			onEvent: (event: IntercomExtensionEvent) => {
				if (generation === sessionGeneration) onIntercomEvent(event);
			},
		});
	});

	pi.on("session_shutdown", () => {
		generation += 1;
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		activeTui = undefined;
		channel = undefined;
		sessions.clear();
		connection = "waiting";
	});

	const hubCommand = {
		description: "Show and focus local Pi sessions",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("Pi Hub requires an interactive terminal", "warning");
				return;
			}
			await refresh();
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						activeTui = tui;
						ticker = setInterval(() => tui.requestRender(), 1000);
						ticker.unref?.();
						return new PiHubOverlay(
							tui,
							theme,
							done,
							snapshot,
							refresh,
							(session) => focusPiSession(session.pid),
						);
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "80%",
							minWidth: 52,
							maxHeight: "85%",
						},
					},
				);
			} finally {
				if (ticker) clearInterval(ticker);
				ticker = undefined;
				activeTui = undefined;
			}
		},
	};
	pi.registerCommand("hub", hubCommand);
	pi.registerShortcut("ctrl+h", {
		description: hubCommand.description,
		handler: (ctx) => hubCommand.handler("", ctx),
	});
}
