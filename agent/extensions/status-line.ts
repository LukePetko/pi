import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

type SpeedState = {
	running: boolean;
	startedAt: number;
	lastUpdateAt: number;
	estimatedTokens: number;
	chars: number;
	exactOutputTokens?: number;
	finalTokensPerSecond?: number;
};

const TOKEN_CHARS = 4;

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let hiddenBySidebar = false;
	let lastCtx: ExtensionContext | undefined;
	let promptStartedAt = 0;
	let promptEndedAt = 0;
	let promptRunning = false;
	const state: SpeedState = resetState();

	function resetState(): SpeedState {
		return {
			running: false,
			startedAt: 0,
			lastUpdateAt: 0,
			estimatedTokens: 0,
			chars: 0,
		};
	}

	function copyReset(): void {
		Object.assign(state, resetState());
	}

	function n(value: number, digits = 1): string {
		if (!Number.isFinite(value)) return "0";
		const abs = Math.abs(value);
		if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
		if (abs >= 1_000) return `${(value / 1_000).toFixed(digits)}k`;
		return abs >= 100 ? value.toFixed(0) : value.toFixed(digits);
	}

	function money(value: number): string {
		return `$${value >= 1 ? value.toFixed(2) : value.toFixed(3)}`;
	}

	function sessionTotals(ctx: ExtensionContext) {
		const totals = { input: 0, output: 0, cost: 0, usingSubscription: false };
		const model = (ctx as any).model;
		totals.usingSubscription = !!(
			model && (ctx as any).modelRegistry?.isUsingOAuth?.(model)
		);
		for (const entry of ctx.sessionManager.getBranch() as any[]) {
			const msg = entry?.message;
			if (msg?.role !== "assistant" || !msg.usage) continue;
			totals.input += msg.usage.input ?? 0;
			totals.output += msg.usage.output ?? 0;
			totals.cost += msg.usage.cost?.total ?? 0;
		}
		return totals;
	}

	function rgb(hex: string, text: string): string {
		const clean = hex.replace("#", "");
		const r = Number.parseInt(clean.slice(0, 2), 16);
		const g = Number.parseInt(clean.slice(2, 4), 16);
		const b = Number.parseInt(clean.slice(4, 6), 16);
		return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
	}

	function gray(text: string): string {
		return `\x1b[90m${text}\x1b[0m`;
	}

	function modelLine(ctx: ExtensionContext): string {
		const model = (ctx as any).model;
		const name = model?.name ?? model?.id ?? "model";
		return `${rgb("#c084fc", name)}${gray("@")}${rgb("#7dd3fc", pi.getThinkingLevel())}`;
	}

	function timePart(): string {
		if (!promptRunning && !promptEndedAt && !state.lastUpdateAt) return "";

		const now = promptRunning
			? Date.now()
			: promptEndedAt || state.lastUpdateAt;
		const elapsedStart = promptStartedAt || state.startedAt || now;
		const elapsedSeconds = Math.max(0, (now - elapsedStart) / 1000);
		return `${promptRunning ? "⚡" : "✓"} ${n(elapsedSeconds)}s`;
	}

	function statsLine(ctx: ExtensionContext): string {
		const totals = sessionTotals(ctx);
		const context = ctx.getContextUsage();
		const contextPart = context
			? `${context.tokens == null ? "?" : n(context.tokens)}/${context.contextWindow == null ? "?" : n(context.contextWindow)} (${context.percent == null ? "?" : n(context.percent)}%)`
			: "?/? (?)";

		const costPart =
			totals.cost || totals.usingSubscription
				? rgb(
						"#fb923c",
						`${money(totals.cost)}${totals.usingSubscription ? " (sub)" : ""}`,
					)
				: "";
		const time = timePart();
		return `↑${n(totals.input, 0)}↓${n(totals.output, 0)}${costPart ? ` ${costPart}` : ""} ${gray("·")} ${contextPart}${time ? ` ${gray("·")} ${time}` : ""}`;
	}

	function pathLine(ctx: ExtensionContext): string {
		return `${gray("cwd")} ${ctx.cwd}`;
	}

	function render(ctx: ExtensionContext): void {
		lastCtx = ctx;
		if (!enabled) {
			ctx.ui.setFooter(undefined);
			return;
		}

		if (hiddenBySidebar) {
			// Keep overriding pi's built-in footer with an empty footer while the sidebar is open.
			ctx.ui.setFooter(() => ({
				invalidate() {},
				render() {
					return [];
				},
			}));
			return;
		}

		// Replaces pi's built-in footer/status line entirely.
		ctx.ui.setFooter((_tui, _theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return [
					truncateToWidth(modelLine(ctx), width),
					truncateToWidth(statsLine(ctx), width),
					truncateToWidth(pathLine(ctx), width),
				];
			},
		}));
	}

	pi.events.on("sidebar:active", (active: unknown) => {
		hiddenBySidebar = active === true;
		if (lastCtx) render(lastCtx);
	});

	pi.on("session_start", async (_event, ctx) => render(ctx));
	pi.on("model_select", async (_event, ctx) => render(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => render(ctx));
	pi.on("turn_end", async (_event, ctx) => render(ctx));

	pi.on("agent_start", async (_event, ctx) => {
		promptStartedAt = Date.now();
		promptEndedAt = 0;
		promptRunning = true;
		copyReset();
		render(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		promptEndedAt = Date.now();
		promptRunning = false;
		if (state.startedAt) {
			const elapsedSeconds = Math.max(
				0.001,
				(promptEndedAt - (promptStartedAt || state.startedAt)) / 1000,
			);
			state.finalTokensPerSecond =
				(state.exactOutputTokens ?? state.estimatedTokens) / elapsedSeconds;
		}
		render(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (!enabled || event.message?.role !== "assistant") return;
		if (!promptRunning) {
			promptStartedAt = Date.now();
			promptEndedAt = 0;
			promptRunning = true;
		}
		state.running = true;
		state.startedAt = promptStartedAt;
		state.lastUpdateAt = state.startedAt;
		render(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		if (!enabled || event.message?.role !== "assistant") return;
		const update = event.assistantMessageEvent as
			| { type?: string; delta?: string }
			| undefined;
		if (
			update?.type === "text_delta" ||
			update?.type === "thinking_delta" ||
			update?.type === "toolcall_delta"
		) {
			state.chars += (update.delta ?? "").length;
			state.estimatedTokens = Math.max(1, state.chars / TOKEN_CHARS);
			state.lastUpdateAt = Date.now();
			render(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled || event.message?.role !== "assistant") return;
		state.running = false;
		state.lastUpdateAt = Date.now();
		const usage = event.message.usage as { output?: number } | undefined;
		if (typeof usage?.output === "number" && usage.output > 0)
			state.exactOutputTokens = usage.output;
		const elapsedSeconds = Math.max(
			0.001,
			(state.lastUpdateAt - (promptStartedAt || state.startedAt)) / 1000,
		);
		state.finalTokensPerSecond =
			(state.exactOutputTokens ?? state.estimatedTokens) / elapsedSeconds;
		render(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setFooter(undefined);
	});

	pi.registerCommand("statusline", {
		description: "Toggle the custom two-row status line",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (!enabled) {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Status line disabled; default footer restored", "info");
			} else {
				ctx.ui.notify("Status line enabled", "info");
				render(ctx);
			}
		},
	});
}
