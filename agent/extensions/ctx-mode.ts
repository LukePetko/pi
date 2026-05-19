import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type CtxMode = "off" | "light" | "strict";

const STATE_PATH = join(
	process.env.HOME ?? ".",
	".pi",
	"agent",
	"ctx-mode.json",
);
const MODES = new Set<CtxMode>(["off", "light", "strict"]);

function loadMode(): CtxMode {
	try {
		if (!existsSync(STATE_PATH)) return "light";
		const mode = JSON.parse(readFileSync(STATE_PATH, "utf8"))?.mode;
		return MODES.has(mode) ? mode : "light";
	} catch {
		return "light";
	}
}

function saveMode(mode: CtxMode): void {
	writeFileSync(STATE_PATH, `${JSON.stringify({ mode }, null, 2)}\n`);
}

function estimateTokensFromStatusline(text: string): string {
	const match = text.match(/([\d.]+)\s*(KB|MB) kept out/i);
	if (!match) return text;
	const value = Number(match[1]);
	const bytes =
		match[2].toUpperCase() === "MB" ? value * 1024 * 1024 : value * 1024;
	const tokens = Math.round(bytes / 4);
	const compact =
		tokens >= 1_000_000
			? `${(tokens / 1_000_000).toFixed(1)}M`
			: tokens >= 1_000
				? `${(tokens / 1_000).toFixed(1)}k`
				: `${tokens}`;
	return text.replace(match[0], `${match[0]} · ~${compact} tokens`);
}

function contextStatusline(): Promise<string> {
	return new Promise((resolve) => {
		const child = spawn("context-mode", ["statusline"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let output = "";
		const timeout = setTimeout(() => {
			child.kill();
			resolve("context-mode stats unavailable");
		}, 5_000);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			resolve(error.message);
		});
		child.on("close", () => {
			clearTimeout(timeout);
			const clean = output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
			resolve(estimateTokensFromStatusline(clean));
		});
	});
}

function instructions(mode: CtxMode): string {
	if (mode === "off") {
		return [
			"## User Context Mode Preference: off",
			"Use normal Pi tools. Do not prefer context-mode tools unless the user explicitly asks for them.",
			"Still avoid dumping huge raw outputs into the conversation when a concise command or targeted read is enough.",
		].join("\n");
	}

	if (mode === "strict") {
		return [
			"## User Context Mode Preference: strict",
			"Prefer context-mode tools for exploration and any data-heavy operation.",
			"Use ctx_batch_execute for multi-command discovery, ctx_execute/ctx_execute_file for analysis, and ctx_fetch_and_index/ctx_search for web/docs.",
			"Do not use raw Bash/Read for broad analysis or outputs likely over 20 lines.",
			"Before precise edits, directly inspect the target files and keep diffs small. After edits, encourage /diff review.",
		].join("\n");
	}

	return [
		"## User Context Mode Preference: light",
		"Use context-mode for high-noise work: large logs, broad repo searches, web/docs indexing, dependency analysis, test/build output summaries, and multi-file statistics.",
		"Use normal direct Read/Edit for ownership-critical precise source changes. Before editing, inspect relevant files directly; after editing, keep changes reviewable.",
		"If a command may output more than ~20 lines, prefer ctx_execute or ctx_batch_execute and print only the useful summary.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let mode: CtxMode = loadMode();

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("ctx-mode", mode === "off" ? "ctx off" : `ctx ${mode}`);
	}

	pi.on("session_start", async (_event, ctx) => {
		setStatus(ctx);
		ctx.ui.setWidget("ctx-savings", []);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setStatus(ctx);
		return { systemPrompt: `${event.systemPrompt}\n\n${instructions(mode)}` };
	});

	pi.on("tool_call", async (event) => {
		if (mode !== "strict" || event.toolName !== "bash") return;
		const command = String((event.input as any)?.command ?? "");
		if (/\b(curl|wget)\b/.test(command)) {
			return {
				block: true,
				reason:
					"ctx-mode strict: use ctx_fetch_and_index or ctx_execute for HTTP instead of raw curl/wget.",
			};
		}
	});

	pi.registerCommand("ctxmode", {
		description: "Set context-mode preference: off, light, strict",
		handler: async (args, ctx) => {
			const next = String(args ?? "")
				.trim()
				.toLowerCase() as CtxMode;
			if (!next) {
				ctx.ui.notify(`Context mode: ${mode}`, "info");
				return;
			}
			if (!MODES.has(next)) {
				ctx.ui.notify("Usage: /ctxmode off | light | strict", "error");
				return;
			}
			mode = next;
			saveMode(mode);
			setStatus(ctx);
			ctx.ui.notify(`Context mode set to ${mode}`, "info");
		},
	});

	async function showSavings(ctx: ExtensionContext): Promise<void> {
		ctx.ui.setWidget("ctx-savings", []);
		ctx.ui.notify(await contextStatusline(), "info");
	}

	pi.registerCommand("ctxstats", {
		description: "Show compact context-mode savings status",
		handler: async (_args, ctx) => showSavings(ctx),
	});

	pi.registerCommand("ctx-savings", {
		description: "Show compact context-mode savings status",
		handler: async (_args, ctx) => showSavings(ctx),
	});

	pi.registerCommand("ctxclear", {
		description: "Clear context-mode savings widget",
		handler: async (_args, ctx) => {
			ctx.ui.setWidget("ctx-savings", []);
		},
	});
}
