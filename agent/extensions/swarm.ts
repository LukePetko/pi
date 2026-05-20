// @ts-nocheck
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Role = { name: string; body: string; suggestedAgent: string };

const MAX_ROLE_CHARS = Number(process.env.PI_SWARM_MAX_ROLE_CHARS || "8000");
const MAX_ROLES = Number(process.env.PI_SWARM_MAX_ROLES || "6");

function truncate(text: string, max: number) {
	return text.length <= max
		? text
		: `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function shellWords(input: string) {
	const words: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(input))) words.push(match[1] ?? match[2] ?? match[3]);
	return words;
}

function slug(name: string) {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40) || "agent"
	);
}

function suggestedAgent(name: string, body: string) {
	const text = `${name}\n${body}`.toLowerCase();
	if (/research|docs|source|web|external|benchmark|api/.test(text))
		return "researcher";
	if (
		/review|critic|audit|security|quality|test|correctness|performance/.test(
			text,
		)
	)
		return "reviewer";
	if (/plan|architect|design|spec/.test(text)) return "planner";
	if (/implement|build|code|worker|fix/.test(text)) return "worker";
	if (/scout|inspect|map|discover|recon/.test(text)) return "scout";
	return "delegate";
}

function parseRoles(markdown: string): Role[] {
	const lines = markdown.split(/\r?\n/);
	const headingRoles: Role[] = [];
	let current: { name: string; lines: string[] } | undefined;
	for (const line of lines) {
		const match = line.match(/^#{1,3}\s+(.+?)\s*$/);
		if (match) {
			if (current && current.lines.join("\n").trim()) {
				const body = current.lines.join("\n").trim();
				headingRoles.push({
					name: current.name,
					body,
					suggestedAgent: suggestedAgent(current.name, body),
				});
			}
			current = { name: match[1].trim(), lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current && current.lines.join("\n").trim()) {
		const body = current.lines.join("\n").trim();
		headingRoles.push({
			name: current.name,
			body,
			suggestedAgent: suggestedAgent(current.name, body),
		});
	}

	const filtered = headingRoles.filter((role) => {
		const text = `${role.name}\n${role.body}`.toLowerCase();
		return /agent|role|review|research|analyst|critic|planner|worker|architect|specialist|scout|security|performance|test|quality/.test(
			text,
		);
	});
	return (filtered.length ? filtered : headingRoles).slice(0, MAX_ROLES);
}

function buildSwarmPrompt(file: string, roles: Role[], task: string) {
	const specs = roles
		.map(
			(role, index) =>
				`## Role ${index + 1}: ${role.name}\nSuggested subagent: ${role.suggestedAgent}\n\n${truncate(role.body, MAX_ROLE_CHARS)}`,
		)
		.join("\n\n---\n\n");
	return `Run a one-time subagent swarm using the role specs read from ${file}. Do not install or persist these agents. Use pi-subagents with parallel tasks where possible. For each role, choose the suggested builtin subagent unless another builtin is clearly better, and inject the role instructions into that child task. After all children finish, synthesize the results and call out disagreements.\n\nTask:\n${task}\n\nRole specs:\n\n${specs}`;
}

export default function swarm(pi: ExtensionAPI) {
	pi.registerCommand("swarm", {
		description:
			"Run a one-time subagent swarm from a local markdown team/agent spec. Usage: /swarm <file.md> -- <task>",
		handler: async (args: string, ctx: any) => {
			const raw = args.trim();
			if (!raw || !raw.includes("--")) {
				ctx.ui.notify("Usage: /swarm <file.md> -- <task>", "warning");
				return;
			}
			const [left, ...rightParts] = raw.split(/\s+--\s+/);
			const task = rightParts.join(" -- ").trim();
			const fileArg = shellWords(left)[0];
			if (!fileArg || !task) {
				ctx.ui.notify("Usage: /swarm <file.md> -- <task>", "warning");
				return;
			}
			const file = resolve(ctx.cwd, fileArg);
			if (!existsSync(file)) {
				ctx.ui.notify(`Swarm file not found: ${file}`, "warning");
				return;
			}
			const markdown = readFileSync(file, "utf8");
			const roles = parseRoles(markdown);
			if (!roles.length) {
				ctx.ui.notify(
					`No roles found in ${fileArg}. Use markdown headings for each role.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Starting one-time swarm with ${roles.length} role(s): ${roles.map((r) => r.name).join(", ")}`,
				"info",
			);
			pi.sendUserMessage(buildSwarmPrompt(fileArg, roles, task));
		},
	});
}
