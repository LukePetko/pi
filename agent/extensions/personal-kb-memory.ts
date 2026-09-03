import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const KB_ROOT = join(process.env.HOME ?? ".", ".pi-knowledge");
const MAX_CORE_CHARS = 6_000;
const MAX_PROJECT_CHARS = 4_000;

function readBudgeted(path: string, maxChars: number): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const content = readFileSync(path, "utf8").trim();
		if (content.length <= maxChars) return content;
		return `${content.slice(0, maxChars)}\n\n<!-- truncated by personal-kb-memory -->`;
	} catch {
		return undefined;
	}
}

function projectCandidates(ctx: ExtensionContext): string[] {
	const leaf = basename(ctx.cwd);
	return [
		join(KB_ROOT, "projects", leaf, "context.md"),
		join(KB_ROOT, "projects", leaf, "README.md"),
	];
}

function coreMemory(): string[] {
	return [
		["USER.md", readBudgeted(join(KB_ROOT, "USER.md"), MAX_CORE_CHARS)],
		["MEMORY.md", readBudgeted(join(KB_ROOT, "MEMORY.md"), MAX_CORE_CHARS)],
	]
		.filter((entry): entry is [string, string] => Boolean(entry[1]))
		.map(([name, content]) => `## ${name}\n\n${content}`);
}

function projectMemory(ctx: ExtensionContext): string | undefined {
	for (const candidate of projectCandidates(ctx)) {
		const content = readBudgeted(candidate, MAX_PROJECT_CHARS);
		if (content) return `## Project memory: ${candidate}\n\n${content}`;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (_event, ctx) => {
		const sections = [...coreMemory()];
		const project = projectMemory(ctx);
		if (project) sections.push(project);
		if (sections.length === 0) return;

		return {
			systemPrompt: `${_event.systemPrompt}\n\n<personal_kb_memory>\n${sections.join("\n\n---\n\n")}\n</personal_kb_memory>`,
		};
	});
}
