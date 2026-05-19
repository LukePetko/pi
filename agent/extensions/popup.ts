import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { Component, OverlayHandle } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PANEL_WIDTH = 68;
const PANEL_MIN_TERMINAL_WIDTH = 80;
const CODEX_REFRESH_MS = 60_000;
const CTX_MODE_PATH = join(
	process.env.HOME ?? ".",
	".pi",
	"agent",
	"ctx-mode.json",
);

type CodexLimit = {
	limitId: string;
	limitName?: string | null;
	primary?: {
		usedPercent?: number;
		windowDurationMins?: number;
		resetsAt?: number;
	};
	secondary?: {
		usedPercent?: number;
		windowDurationMins?: number;
		resetsAt?: number;
	};
	planType?: string | null;
};

type CodexUsage = {
	account?: { email?: string; planType?: string };
	limits?: CodexLimit[];
	error?: string;
	fetchedAt?: number;
};

type GitStatus = {
	branch?: string;
	staged: number;
	unstaged: number;
	untracked: number;
	error?: string;
};

function readCtxMode(): string {
	try {
		if (!existsSync(CTX_MODE_PATH)) return "light";
		const mode = JSON.parse(readFileSync(CTX_MODE_PATH, "utf8"))?.mode;
		return typeof mode === "string" ? mode : "light";
	} catch {
		return "light";
	}
}

function runGit(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 2_000, maxBuffer: 1024 * 1024 },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout.trimEnd());
			},
		);
	});
}

async function fetchGitStatus(cwd: string): Promise<GitStatus> {
	try {
		await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
		const [branchRaw, head, status] = await Promise.all([
			runGit(["branch", "--show-current"], cwd).catch(() => ""),
			runGit(["rev-parse", "--short", "HEAD"], cwd).catch(() => ""),
			runGit(["status", "--porcelain", "--untracked-files=normal"], cwd),
		]);

		let staged = 0;
		let unstaged = 0;
		let untracked = 0;
		for (const line of status.split("\n")) {
			if (!line) continue;
			if (line.startsWith("??")) {
				untracked++;
				continue;
			}
			if (line[0] !== " ") staged++;
			if (line[1] !== " ") unstaged++;
		}

		return {
			branch: branchRaw || (head ? `detached@${head}` : "unknown"),
			staged,
			unstaged,
			untracked,
		};
	} catch {
		return { staged: 0, unstaged: 0, untracked: 0, error: "not a git repo" };
	}
}

function fetchCodexUsage(): Promise<CodexUsage> {
	return new Promise((resolve) => {
		const child = spawn(
			"codex",
			["-s", "read-only", "-a", "untrusted", "app-server"],
			{
				stdio: ["pipe", "pipe", "ignore"],
			},
		);

		let buffer = "";
		let accountResult: any;
		let limitsResult: any;
		let settled = false;

		const finish = (usage: CodexUsage) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			child.kill();
			resolve({ ...usage, fetchedAt: Date.now() });
		};

		const timeout = setTimeout(
			() => finish({ error: "codex app-server timed out" }),
			25_000,
		);

		const send = (id: number, method: string, params: unknown = {}) => {
			child.stdin.write(
				JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
			);
		};

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			for (;;) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				const line = buffer.slice(0, idx).trim();
				buffer = buffer.slice(idx + 1);
				if (!line) continue;

				try {
					const msg = JSON.parse(line);
					if (msg.id === 1) {
						if (msg.error)
							return finish({
								error: msg.error.message ?? JSON.stringify(msg.error),
							});
						send(2, "account/read");
						send(3, "account/rateLimits/read");
					} else if (msg.id === 2) {
						if (msg.error)
							return finish({
								error: msg.error.message ?? JSON.stringify(msg.error),
							});
						accountResult = msg.result;
					} else if (msg.id === 3) {
						if (msg.error)
							return finish({
								error: msg.error.message ?? JSON.stringify(msg.error),
							});
						limitsResult = msg.result;
					}

					if (accountResult && limitsResult) {
						const byId = limitsResult?.rateLimitsByLimitId ?? {};
						const limits = Object.values(byId) as CodexLimit[];
						finish({ account: accountResult?.account, limits });
					}
				} catch {
					// Ignore non-JSON log lines.
				}
			}
		});

		child.on("error", (error) => finish({ error: error.message }));

		send(1, "initialize", { clientInfo: { name: "pi-popup", version: "0" } });
	});
}

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let handle: OverlayHandle | null = null;
	let activeTui: { requestRender: () => void } | null = null;
	let codexUsage: CodexUsage = {};
	let gitStatus: GitStatus = { staged: 0, unstaged: 0, untracked: 0 };
	let refreshTimer: ReturnType<typeof setInterval> | undefined;

	async function refreshCodexUsage(): Promise<void> {
		codexUsage = await fetchCodexUsage();
		activeTui?.requestRender();
	}

	async function refreshGitStatus(ctx: ExtensionContext): Promise<void> {
		gitStatus = await fetchGitStatus(ctx.cwd);
		activeTui?.requestRender();
	}

	function startCodexRefresh(): void {
		if (refreshTimer) return;
		void refreshCodexUsage();
		refreshTimer = setInterval(
			() => void refreshCodexUsage(),
			CODEX_REFRESH_MS,
		);
	}

	function stopCodexRefresh(): void {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	}

	function show(ctx: ExtensionContext): void {
		if (!enabled || handle) return;

		void ctx.ui
			.custom<void>(
				(tui, theme, _keybindings, _done) => {
					activeTui = tui;
					void refreshGitStatus(ctx);
					return new FloatingPanel(
						tui,
						theme,
						ctx,
						pi,
						() => codexUsage,
						() => gitStatus,
					);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: PANEL_WIDTH,
						nonCapturing: true,
						visible: (termWidth) => termWidth >= PANEL_MIN_TERMINAL_WIDTH,
					},
					onHandle: (overlayHandle) => {
						handle = overlayHandle;
					},
				},
			)
			.finally(() => {
				handle = null;
				activeTui = null;
			});

		startCodexRefresh();
	}

	function hide(): void {
		const h = handle;
		handle = null;
		activeTui = null;
		h?.hide();
		stopCodexRefresh();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) show(ctx);
	});
	pi.on("thinking_level_select", async () => {
		activeTui?.requestRender();
	});
	pi.on("input", async (_event, ctx) => {
		void refreshGitStatus(ctx);
		return { action: "continue" };
	});
	pi.on("tool_execution_end", async (_event, ctx) => {
		void refreshGitStatus(ctx);
	});
	pi.on("model_select", async () => {
		activeTui?.requestRender();
	});
	pi.on("session_shutdown", async () => hide());

	function toggle(ctx: ExtensionContext): void {
		enabled = !enabled;
		if (enabled) show(ctx);
		else hide();
	}

	pi.registerCommand("popup", {
		description: "Toggle the popup status panel",
		handler: async (_args, ctx) => toggle(ctx),
	});

	pi.registerShortcut("ctrl+b", {
		description: "Toggle the popup status panel",
		handler: async (ctx) => toggle(ctx),
	});
}

class FloatingPanel implements Component {
	constructor(
		private tui: any,
		private theme: any,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
		private getCodexUsage: () => CodexUsage,
		private getGitStatus: () => GitStatus,
	) {}

	private rgb(hex: string, text: string): string {
		const clean = hex.replace("#", "");
		const r = Number.parseInt(clean.slice(0, 2), 16);
		const g = Number.parseInt(clean.slice(2, 4), 16);
		const b = Number.parseInt(clean.slice(4, 6), 16);
		return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
	}

	private gray(text: string): string {
		return this.rgb("#a1a1aa", text);
	}

	private pad(content: string, width: number): string {
		const truncated = truncateToWidth(content, width);
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	private n(value: number, digits = 1): string {
		if (!Number.isFinite(value)) return "0";
		const abs = Math.abs(value);
		if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
		if (abs >= 1_000) return `${(value / 1_000).toFixed(digits)}k`;
		return abs >= 100 ? value.toFixed(0) : value.toFixed(digits);
	}

	private money(value: number): string {
		return `$${value >= 1 ? value.toFixed(2) : value.toFixed(3)}`;
	}

	private timeUntil(epochSeconds?: number): string {
		if (!epochSeconds) return "?";
		const ms = epochSeconds * 1000 - Date.now();
		if (ms <= 0) return "now";
		const mins = Math.ceil(ms / 60_000);
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		const rem = mins % 60;
		if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return remHours ? `${days}d ${remHours}h` : `${days}d`;
	}

	private usageBar(percent?: number): string {
		const width = 10;
		if (percent == null || !Number.isFinite(percent))
			return `${this.gray(" ".repeat(width))} ${"?%".padStart(4)}`;

		const clamped = Math.max(0, Math.min(100, percent));
		const units = Math.round((clamped / 100) * width * 4); // 4 sub-levels per cell: ░▒▓█
		const full = Math.floor(units / 4);
		const rem = units % 4;
		const color =
			clamped >= 90 ? "#fb7185" : clamped >= 70 ? "#fbbf24" : "#86efac";
		const partial = rem === 1 ? "░" : rem === 2 ? "▒" : rem === 3 ? "▓" : "";
		const empty = Math.max(0, width - full - (partial ? 1 : 0));
		const filled = `${"█".repeat(full)}${partial}`;
		const blocks = `${this.rgb(color, filled)}${this.gray("·".repeat(empty))}`;
		return `${blocks} ${`${percent}%`.padStart(4)}`;
	}

	private sessionTotals() {
		const totals = { input: 0, output: 0, cost: 0, usingSubscription: false };
		const model = (this.ctx as any).model;
		totals.usingSubscription = !!(
			model && (this.ctx as any).modelRegistry?.isUsingOAuth?.(model)
		);

		const context = buildSessionContext(
			this.ctx.sessionManager.getEntries() as any[],
			this.ctx.sessionManager.getLeafId(),
		);
		for (const msg of context.messages as any[]) {
			if (msg?.role !== "assistant" || !msg.usage) continue;
			totals.input += msg.usage.input ?? 0;
			totals.output += msg.usage.output ?? 0;
			totals.cost += msg.usage.cost?.total ?? 0;
		}
		return totals;
	}

	private title(): string {
		const explicit = (this.ctx.sessionManager as any).getSessionName?.();
		if (explicit) return explicit;

		for (const entry of this.ctx.sessionManager.getBranch() as any[]) {
			const msg = entry?.message;
			if (msg?.role !== "user") continue;
			const content = msg.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter(
									(p: any) => p?.type === "text" && typeof p.text === "string",
								)
								.map((p: any) => p.text)
								.join(" ")
						: "";
			const cleaned = text.replace(/\s+/g, " ").trim();
			if (cleaned) return cleaned;
		}

		return "Untitled chat";
	}

	render(width: number): string[] {
		const padX = 5;
		const innerWidth = Math.max(1, width - 2 - padX * 2);
		const border = (s: string) => this.rgb("#7c3aed", this.theme.bold(s));
		const row = (content = "") =>
			`${border("│")}${" ".repeat(padX)}${this.pad(content, innerWidth)}${" ".repeat(padX)}${border("│")}`;

		const title = this.title();
		const activeModel = (this.ctx as any).model;
		const modelName = activeModel?.name ?? activeModel?.id ?? "model";
		const model = this.rgb("#c084fc", modelName);
		const thinking = this.rgb("#7dd3fc", this.pi.getThinkingLevel());
		const totals = this.sessionTotals();
		const context = this.ctx.getContextUsage();
		const contextText = context
			? `${context.tokens == null ? "?" : this.n(context.tokens)}/${context.contextWindow == null ? "?" : this.n(context.contextWindow)} (${context.percent == null ? "?" : this.n(context.percent)}%)`
			: "?/? (?)";
		const priceText = `${this.money(totals.cost)}${totals.usingSubscription ? " (sub)" : ""}`;
		const ctxMode = readCtxMode();
		const ctxModeColor =
			ctxMode === "strict"
				? "#fbbf24"
				: ctxMode === "off"
					? "#a1a1aa"
					: "#86efac";
		const codex = this.getCodexUsage();
		const git = this.getGitStatus();
		const gitText = git.error
			? this.gray(git.error)
			: `${this.rgb("#c084fc", git.branch ?? "unknown")} ${this.gray("·")} ${this.rgb("#86efac", `${git.staged} staged`)} ${this.gray("·")} ${this.rgb("#fbbf24", `${git.unstaged} dirty`)} ${this.gray("·")} ${this.rgb("#fb7185", `${git.untracked} new`)}`;
		const mainCodex =
			codex.limits?.find((limit) => limit.limitId === "codex") ??
			codex.limits?.[0];
		const codexRows = codex.error
			? [row(this.rgb("#fb7185", `Codex       ${codex.error}`))]
			: mainCodex
				? [
						row(
							`5h          ${this.usageBar(mainCodex.primary?.usedPercent)} ${this.gray(`resets ${this.timeUntil(mainCodex.primary?.resetsAt)}`)}`,
						),
						row(
							`week        ${this.usageBar(mainCodex.secondary?.usedPercent)} ${this.gray(`resets ${this.timeUntil(mainCodex.secondary?.resetsAt)}`)}`,
						),
					]
				: [row(`Codex       ${this.gray("loading...")}`)];

		return [
			`${border("╭")}${border("─".repeat(innerWidth + padX * 2))}${border("╮")}`,
			row(),
			row(this.theme.bold(title)),
			row(),
			row(this.theme.bold("Model")),
			row(`Name        ${model}`),
			row(`Thinking    ${thinking}`),
			row(),
			row(this.theme.bold("Usage")),
			row(`Input       ${this.gray(`${this.n(totals.input, 0)} tokens`)}`),
			row(`Output      ${this.gray(`${this.n(totals.output)} tokens`)}`),
			row(`Price       ${this.rgb("#fb923c", priceText)}`),
			row(`Context     ${this.gray(contextText)}`),
			row(),
			row(this.theme.bold("Codex")),
			...codexRows,
			row(),
			row(this.theme.bold("MCP")),
			row(`${this.rgb(ctxModeColor, "•")} Context Mode ${this.gray(ctxMode)}`),
			row(`${this.rgb("#86efac", "•")} Atlassian ${this.gray("Connected")}`),
			row(),
			row(this.theme.bold("Project")),
			row(`Git         ${gitText}`),
			row(`cwd         ${this.gray(this.ctx.cwd)}`),
			row(),
			row(),
			`${border("╰")}${border("─".repeat(innerWidth + padX * 2))}${border("╯")}`,
		];
	}

	invalidate(): void {
		this.tui?.requestRender?.();
	}
	dispose(): void {}
}
