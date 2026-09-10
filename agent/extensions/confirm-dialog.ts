import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	classifyToolCall,
	DEFAULT_CONFIG,
	parseConfirmDialogConfig,
	type PermissionMatch,
} from "./lib/confirm-dialog.ts";
import { gitRoot } from "./lib/nvim.ts";
import { createPermissionBroker } from "./lib/hub-permissions.ts";
import { loadConfig as loadIntercomConfig } from "../npm/node_modules/pi-intercom/config.ts";

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
	broker?: Awaited<ReturnType<typeof createPermissionBroker>>,
	tool?: { toolName: string; input: unknown },
): Promise<Decision> {
	if (!ctx.hasUI) return "reject";
	let finish: ((decision: Decision) => void) | undefined;
	let resolved: Decision | undefined;
	const controller = new AbortController();
	const id = process.env.PI_INTERCOM_STABLE_ID?.trim() || loadIntercomConfig().stableId || ctx.sessionManager.getSessionId();
	const ticket = broker?.request({ id, pid: process.pid }, {
		title: request.title, description: request.description, cwd: ctx.cwd,
		...(tool ? { toolName: tool.toolName, input: JSON.stringify(tool.input, null, 2) } : {}),
	}, (decision) => {
		resolved = decision;
		controller.abort();
		finish?.(decision);
	});
	void ticket?.ready.catch(() => {
		try { ctx.ui.notify("Permission is waiting locally; Hub publication failed.", "warning"); }
		catch { /* Publication may finish after this UI was disposed. */ }
	});
	try {
		if (ctx.mode !== "tui") {
			const choice = await ctx.ui.select(
				`△ Permission required\n\n${request.title}\n${request.description}`,
				["Allow once", "Allow always", "Reject"], { signal: controller.signal },
			);
			const decision = resolved ?? (choice === "Allow once" ? "once" : choice === "Allow always" ? "always" : "reject");
			ticket?.decide(decision);
			return decision;
		}
		return (await ctx.ui.custom<Decision>((tui, theme, _keybindings, done) => {
			finish = done;
			if (resolved) queueMicrotask(() => done(resolved!));
			return new OpenCodeConfirmDialog(tui, theme, request,
				(decision) => ticket ? ticket.decide(decision) : done(decision));
		})) ?? "reject";
	} finally { ticket?.cancel(); }
}

export default function confirmDialog(pi: ExtensionAPI, brokerFactory = createPermissionBroker) {
	const approvals = new Set<string>();
	let broker: ReturnType<typeof createPermissionBroker> | undefined;
	let generation = 0;
	async function ask(ctx: ExtensionContext, request: PermissionMatch, tool?: { toolName: string; input: unknown }): Promise<Decision> {
		if (!ctx.hasUI) return "reject";
		const currentGeneration = generation;
		if (!broker) {
			const created = brokerFactory();
			broker = created;
			void created.catch(() => { if (broker === created) broker = undefined; });
		}
		const owner = await broker.catch(() => undefined);
		if (generation !== currentGeneration) return "reject";
		if (!owner) ctx.ui.notify("Hub permission bridge unavailable; use this terminal.", "warning");
		return askPermission(ctx, request, owner, tool);
	}
	pi.on("session_shutdown", async () => {
		generation++;
		approvals.clear();
		const owner = broker;
		broker = undefined;
		await (await owner?.catch(() => undefined))?.close();
	});

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

		const decision = await ask(ctx, request, { toolName: event.toolName, input: event.input });
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
				const decision = await ask(ctx, {
					id: "preview",
					action: "ask",
					title: "Preview an echo command (nothing executes)",
					description: '$ echo "Hello from Pi"',
					approvalKey: "preview",
				}, { toolName: "bash", input: { command: 'echo "Hello from Pi"' } });
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
