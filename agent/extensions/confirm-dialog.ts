import { readFileSync } from "node:fs";
import { join } from "node:path";
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
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import {
	classifyToolCall,
	DEFAULT_CONFIG,
	parseConfirmDialogConfig,
	type PermissionMatch,
} from "./lib/confirm-dialog.ts";
import { gitRoot } from "./lib/nvim.ts";

const CONFIG_PATH = join(
	process.env.HOME ?? ".",
	".pi",
	"agent",
	"confirm-dialog.json",
);

type Decision = "once" | "always" | "reject";
type Stage = "permission" | "always";

type Choice = {
	value: Decision | "cancel";
	label: string;
};

function loadConfig(): ReturnType<typeof parseConfirmDialogConfig> {
	try {
		return parseConfirmDialogConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

class OpenCodeConfirmDialog implements Component {
	private stage: Stage = "permission";
	private selected = 0;

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly theme: Theme,
		private readonly request: PermissionMatch,
		private readonly done: (decision: Decision) => void,
	) {}

	private choices(): Choice[] {
		return this.stage === "always"
			? [
					{ value: "always", label: "Confirm" },
					{ value: "cancel", label: "Cancel" },
				]
			: [
					{ value: "once", label: "Allow once" },
					{ value: "always", label: "Allow always" },
					{ value: "reject", label: "Reject" },
				];
	}

	private move(offset: number): void {
		const choices = this.choices();
		this.selected = (this.selected + offset + choices.length) % choices.length;
		this.tui.requestRender();
	}

	private select(): void {
		const choice = this.choices()[this.selected]?.value;
		if (choice === "cancel") {
			this.stage = "permission";
			this.selected = 1;
			this.tui.requestRender();
			return;
		}
		if (choice === "always" && this.stage === "permission") {
			this.stage = "always";
			this.selected = 0;
			this.tui.requestRender();
			return;
		}
		if (choice) this.done(choice);
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.left) ||
			matchesKey(data, Key.shift("tab")) ||
			data === "h"
		) {
			this.move(-1);
			return;
		}
		if (
			matchesKey(data, Key.right) ||
			matchesKey(data, Key.tab) ||
			data === "l"
		) {
			this.move(1);
			return;
		}
		if (this.stage === "permission" && /^[123]$/u.test(data)) {
			this.selected = Number(data) - 1;
			this.select();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.select();
			return;
		}
		if (!matchesKey(data, Key.escape)) return;
		if (this.stage === "always") {
			this.stage = "permission";
			this.selected = 1;
			this.tui.requestRender();
			return;
		}
		this.done("reject");
	}

	render(width: number): string[] {
		const panelWidth = Math.max(1, width);
		const contentWidth = Math.max(1, panelWidth - 5);
		const row = (
			content = "",
			background: "toolPendingBg" | "selectedBg" = "toolPendingBg",
		) =>
			this.theme.fg("warning", "┃") +
			this.theme.bg(background, padAnsi(` ${content}`, panelWidth - 1));
		const wrappedRows = (text: string) =>
			text
				.split("\n")
				.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
				.map((line) => row(`  ${line}`));
		const title =
			this.stage === "always" ? "Always allow" : "Permission required";
		const choices = this.choices();
		const buttons = choices.map((choice, index) => {
			const label = ` ${choice.label} `;
			return index === this.selected
				? this.theme.inverse(this.theme.fg("warning", label))
				: this.theme.fg("muted", label);
		});
		const hints = `${this.theme.fg("text", "⇆")} ${this.theme.fg("muted", "select")}  ${this.theme.fg("text", "enter")} ${this.theme.fg("muted", "confirm")}  ${this.theme.fg("text", "esc")} ${this.theme.fg("muted", this.stage === "always" ? "cancel" : "reject")}`;
		const buttonRow = buttons.join(" ");
		const combinedRow = `${buttonRow}  ${hints}`;
		let actionRows: string[];
		if (visibleWidth(combinedRow) <= panelWidth - 2) {
			actionRows = [row(combinedRow, "selectedBg")];
		} else if (visibleWidth(buttonRow) <= panelWidth - 2) {
			actionRows = [
				row(buttonRow, "selectedBg"),
				row(hints, "selectedBg"),
			];
		} else {
			actionRows = [
				...buttons.map((button) => row(button, "selectedBg")),
				row(hints, "selectedBg"),
			];
		}

		return [
			row(),
			row(
				`${this.theme.fg("warning", "△")} ${this.theme.fg("text", title)}`,
			),
			row(),
			...(this.stage === "always"
				? wrappedRows(
						"This allows future matching operations for the rest of the current Pi session.",
					)
				: [
						row(
							`${this.theme.fg("muted", "#")} ${this.theme.fg("text", this.request.title)}`,
						),
						...wrappedRows(this.request.description),
					]),
			row(),
			...actionRows,
		];
	}

	invalidate(): void {}
}

async function askPermission(
	ctx: ExtensionContext,
	request: PermissionMatch,
): Promise<Decision> {
	if (!ctx.hasUI) return "reject";
	if (ctx.mode !== "tui") {
		const choice = await ctx.ui.select(
			`△ Permission required\n\n${request.title}\n${request.description}`,
			["Allow once", "Allow always", "Reject"],
		);
		if (choice === "Allow once") return "once";
		if (choice === "Allow always") return "always";
		return "reject";
	}

	return (
		(await ctx.ui.custom<Decision>((tui, theme, _keybindings, done) =>
			new OpenCodeConfirmDialog(tui, theme, request, done),
		)) ?? "reject"
	);
}

export default function confirmDialog(pi: ExtensionAPI) {
	const approvals = new Set<string>();

	pi.on("tool_call", async (event, ctx) => {
		const request = classifyToolCall({
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			cwd: ctx.cwd,
			config: loadConfig(),
			gitRoot,
		});
		if (!request) return;
		if (request.action === "deny") {
			return { block: true, reason: `Blocked by confirm-dialog rule: ${request.id}` };
		}
		if (approvals.has(request.approvalKey)) return;

		const decision = await askPermission(ctx, request);
		if (decision === "always") {
			approvals.add(request.approvalKey);
			return;
		}
		if (decision === "once") return;
		return { block: true, reason: `Rejected by user: ${request.title}` };
	});

	pi.registerCommand("confirm-dialog", {
		description: "Show confirm-dialog status or preview it with /confirm-dialog test",
		handler: async (args, ctx) => {
			if (args.trim() === "test") {
				const decision = await askPermission(ctx, {
					id: "preview",
					action: "ask",
					title: "Preview a protected command",
					description: "$ git -C ../another-project push origin main",
					approvalKey: "preview",
				});
				ctx.ui.notify(`Preview result: ${decision}`, "info");
				return;
			}
			ctx.ui.notify(
				`Confirm dialog: ${loadConfig().enabled ? "enabled" : "disabled"}\nConfig: ${CONFIG_PATH}\nSession approvals: ${approvals.size}`,
				"info",
			);
		},
	});
}
