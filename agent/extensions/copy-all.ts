import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block) => {
			if (!block || typeof block !== "object" || !("type" in block)) return "";
			if (
				block.type === "text" &&
				"text" in block &&
				typeof block.text === "string"
			) {
				return block.text;
			}
			if (block.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function copyToClipboard(text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("pbcopy");
		let stderr = "";

		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `pbcopy exited with ${code}`));
		});
		child.stdin.end(text);
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy-all", {
		description: "Copy all user and assistant messages in this thread",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const messages = (ctx.sessionManager.getBranch() as any[])
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message)
				.filter(
					(message) =>
						message?.role === "user" || message?.role === "assistant",
				);

			const text = messages
				.map((message) => {
					const content = textFromContent(message.content).trim();
					return content ? `${message.role.toUpperCase()}:\n${content}` : "";
				})
				.filter(Boolean)
				.join("\n\n---\n\n");

			if (!text) {
				ctx.ui.notify("No user or assistant messages to copy", "info");
				return;
			}

			await copyToClipboard(text);
			ctx.ui.notify(`Copied ${messages.length} messages to clipboard`, "info");
		},
	});
}
