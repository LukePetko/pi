import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const CLAUDE_BIN = process.env.PI_CLAUDE_BIN || "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.PI_CLAUDE_TIMEOUT_MS || "120000");
const MAX_PROMPT_CHARS = Number(
	process.env.PI_CLAUDE_MAX_PROMPT_CHARS || "200000",
);
const MAX_OUTPUT_CHARS = Number(
	process.env.PI_CLAUDE_MAX_OUTPUT_CHARS || "50000",
);

type ClaudeSession = {
	name: string;
	id?: string;
	createdAt: string;
	updatedAt: string;
};
type AskClaudeOptions = {
	prompt: string;
	cwd?: string;
	timeoutMs?: number;
	args?: string[];
	sessionId?: string;
	sessionName?: string;
};
type AskClaudeResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	sessionId?: string;
	sessionName?: string;
};

function truncate(text: string, max: number) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function parseClaudeOutput(stdout: string) {
	try {
		const json = JSON.parse(stdout);
		if (json && typeof json === "object" && typeof json.result === "string") {
			return {
				text: json.result,
				sessionId:
					typeof json.session_id === "string" ? json.session_id : undefined,
			};
		}
	} catch {}
	return { text: stdout.trim(), sessionId: undefined };
}

function askClaude(options: AskClaudeOptions): Promise<AskClaudeResult> {
	const prompt = truncate(options.prompt, MAX_PROMPT_CHARS);
	const timeoutMs = Math.max(1000, options.timeoutMs || DEFAULT_TIMEOUT_MS);
	const args = [
		"-p",
		"--output-format",
		"json",
		...(options.sessionId ? ["--resume", options.sessionId] : []),
		...(options.sessionName ? ["--name", options.sessionName] : []),
		...(options.args || []),
	];

	return new Promise((resolve, reject) => {
		const child = spawn(CLAUDE_BIN, args, {
			cwd: options.cwd || process.cwd(),
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let done = false;

		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			child.kill("SIGTERM");
			reject(new Error(`claude timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > MAX_OUTPUT_CHARS * 2)
				stdout = stdout.slice(-MAX_OUTPUT_CHARS);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > MAX_OUTPUT_CHARS * 2)
				stderr = stderr.slice(-MAX_OUTPUT_CHARS);
		});
		child.on("error", (error) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			const parsed = parseClaudeOutput(stdout.trim());
			resolve({
				stdout: truncate(parsed.text, MAX_OUTPUT_CHARS),
				stderr: truncate(stderr.trim(), MAX_OUTPUT_CHARS),
				code,
				signal,
				sessionId: parsed.sessionId || options.sessionId,
				sessionName: options.sessionName,
			});
		});
		child.stdin.end(prompt.endsWith("\n") ? prompt : `${prompt}\n`);
	});
}

export default function askClaudeExtension(pi: ExtensionAPI) {
	const sessions = new Map<string, ClaudeSession>();
	let activeSession = "default";

	function upsertSession(name: string, id?: string) {
		const now = new Date().toISOString();
		const existing = sessions.get(name);
		const session: ClaudeSession = {
			name,
			id: id ?? existing?.id,
			createdAt: existing?.createdAt || now,
			updatedAt: now,
		};
		sessions.set(name, session);
		activeSession = name;
		pi.appendEntry("claude-session", session);
		return session;
	}

	async function askNamedClaude(
		name: string,
		prompt: string,
		opts: {
			cwd?: string;
			timeoutMs?: number;
			args?: string[];
			newSession?: boolean;
		} = {},
	) {
		const existing = sessions.get(name);
		let session = upsertSession(
			name,
			opts.newSession ? undefined : existing?.id,
		);
		let result = await askClaude({
			prompt,
			cwd: opts.cwd,
			timeoutMs: opts.timeoutMs,
			args: opts.args,
			sessionId: opts.newSession ? undefined : session.id,
			sessionName: name,
		});

		// If a stale/bad Claude session id was persisted, transparently start a fresh Claude conversation.
		if (
			result.code !== 0 &&
			session.id &&
			/No conversation found|already in use/i.test(
				`${result.stdout}\n${result.stderr}`,
			)
		) {
			result = await askClaude({
				prompt,
				cwd: opts.cwd,
				timeoutMs: opts.timeoutMs,
				args: opts.args,
				sessionName: name,
			});
		}

		if (result.sessionId) session = upsertSession(name, result.sessionId);
		return { result, session };
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				entry.customType === "claude-session" &&
				entry.data?.name
			) {
				sessions.set(entry.data.name, entry.data as ClaudeSession);
			}
		}
		if (!sessions.has(activeSession)) upsertSession(activeSession);
	});

	pi.registerTool({
		name: "ask_claude",
		label: "Ask Claude",
		description:
			"Ask Claude Code a question by piping a prompt to the local claude CLI. Supports reusable named Claude sessions for back-and-forth review cycles.",
		promptSnippet: "Ask local Claude Code for a second opinion",
		promptGuidelines: [
			"Use ask_claude only when the user explicitly asks to consult Claude or get a second opinion from Claude.",
			"For review cycles, reuse the same ask_claude sessionName so Claude keeps its own conversation state.",
			"When using ask_claude, summarize Claude's answer and mention that it came from Claude.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Prompt to pipe to claude" }),
			sessionName: Type.Optional(
				Type.String({
					description:
						"Reusable Claude session name. Defaults to active/default.",
				}),
			),
			newSession: Type.Optional(
				Type.Boolean({
					description: "Create/reset this named Claude session before asking.",
				}),
			),
			timeoutMs: Type.Optional(
				Type.Number({
					description:
						"Timeout in milliseconds. Default from PI_CLAUDE_TIMEOUT_MS or 120000.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for claude. Defaults to current pi cwd.",
				}),
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional extra CLI arguments to pass to claude.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const name = params.sessionName || activeSession || "default";
			onUpdate?.({
				content: [{ type: "text", text: `Asking Claude session '${name}'...` }],
			});
			const { result, session } = await askNamedClaude(name, params.prompt, {
				cwd: params.cwd || ctx.cwd,
				timeoutMs: params.timeoutMs,
				args: params.args,
				newSession: params.newSession,
			});
			const text = [
				`Claude session: ${name} (${session.id || "new"})`,
				result.stdout
					? `Claude stdout:\n${result.stdout}`
					: "Claude stdout: <empty>",
				result.stderr ? `Claude stderr:\n${result.stderr}` : undefined,
				result.code && result.code !== 0
					? `exit code: ${result.code}`
					: undefined,
				result.signal ? `signal: ${result.signal}` : undefined,
			]
				.filter(Boolean)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: result };
		},
	});

	pi.registerCommand("claude", {
		description:
			"Ask Claude Code. Usage: /claude [--new] [--session name] <prompt>; /claude sessions; /claude use <name>; /claude reset <name>",
		handler: async (args, ctx) => {
			let input = args.trim();
			if (!input) {
				ctx.ui.notify(
					"Usage: /claude [--new] [--session name] <prompt>",
					"warn",
				);
				return;
			}
			if (input === "sessions") {
				const list =
					[...sessions.values()]
						.map(
							(s) =>
								`${s.name}${s.name === activeSession ? " *" : ""}: ${s.id || "<new>"}`,
						)
						.join("\n") || "<none>";
				pi.sendUserMessage(`Claude sessions:\n\n\`\`\`\n${list}\n\`\`\``);
				return;
			}
			if (input.startsWith("use ")) {
				activeSession = input.slice(4).trim() || "default";
				upsertSession(activeSession);
				ctx.ui.notify(`Active Claude session: ${activeSession}`, "info");
				return;
			}
			if (input.startsWith("reset ")) {
				const name = input.slice(6).trim() || activeSession || "default";
				upsertSession(name, undefined);
				ctx.ui.notify(`Reset Claude session: ${name}`, "info");
				return;
			}

			let newSession = false;
			let sessionName = activeSession || "default";
			if (input.startsWith("--new ")) {
				newSession = true;
				input = input.slice(6).trim();
			}
			const match = input.match(/^--session\s+(\S+)\s+([\s\S]+)$/);
			if (match) {
				sessionName = match[1];
				input = match[2].trim();
			}

			ctx.ui.setStatus("claude", `Asking Claude (${sessionName})...`);
			try {
				const { result, session } = await askNamedClaude(sessionName, input, {
					cwd: ctx.cwd,
					newSession,
				});
				const answer = result.stdout || result.stderr || "<empty response>";
				pi.sendUserMessage(
					`Claude responded from session '${sessionName}' (${session.id || "new"}):\n\n\`\`\`\n${answer}\n\`\`\`\n\nUse this response as external input; summarize it or act on it as appropriate.`,
				);
			} finally {
				ctx.ui.setStatus("claude", undefined);
			}
		},
	});
}
