import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const KB_ROOT = join(process.env.HOME ?? ".", ".pi-knowledge");
const INBOX = join(KB_ROOT, "inbox");

function stamp(): string {
	return new Date().toISOString().slice(0, 10);
}

function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "memory"
	);
}

const REVIEW_PROMPT = `Review this session and propose durable personal/project memories worth saving to Lukas's personal KB.

Rules:
- Return only concise Markdown bullets.
- Include only stable preferences, project conventions, decisions, or reusable workflow facts.
- Do not include secrets, credentials, transient task details, or guesses.
- If nothing should be saved, respond exactly: NO_MEMORY_CANDIDATES.`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("memory-review", {
		description:
			"Ask the agent to propose personal-KB memory candidates from this session",
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				pi.sendUserMessage(REVIEW_PROMPT, { deliverAs: "followUp" });
				ctx.ui.notify("Queued memory review after current task", "info");
				return;
			}
			pi.sendUserMessage(REVIEW_PROMPT);
		},
	});

	pi.registerCommand("memory-capture", {
		description:
			"Save provided text to personal-KB inbox (usage: /memory-capture text)",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			if (!text) {
				ctx.ui.notify("Usage: /memory-capture text to save", "warning");
				return;
			}
			mkdirSync(INBOX, { recursive: true });
			const path = join(INBOX, `${stamp()}-${slug(text)}.md`);
			writeFileSync(
				path,
				`---\ntitle: "Memory capture"\ntype: inbox\ntags: [memory-review]\ncreated: ${stamp()}\nupdated: ${stamp()}\n---\n\n# Memory capture\n\n${text}\n`,
			);
			ctx.ui.notify(`Saved memory capture: ${path}`, "info");
		},
	});
}
