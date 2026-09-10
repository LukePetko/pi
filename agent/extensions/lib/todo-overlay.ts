import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { selectTodoCounts } from "../../npm/node_modules/@juicesharp/rpiv-todo/state/selectors.ts";
import { getRenderState } from "../../npm/node_modules/@juicesharp/rpiv-todo/state/store.ts";
import { TodoOverlay as UpstreamTodoOverlay } from "../../npm/node_modules/@juicesharp/rpiv-todo/todo-overlay.ts";

/** Keep upstream replay, filtering, and lifecycle; customize only the widget view. */
export class TodoOverlay extends UpstreamTodoOverlay {
	private compact = false;
	private compactTui: TUI | undefined;
	private uiAdapters = new WeakMap<ExtensionUIContext, ExtensionUIContext>();

	override setUICtx(ui: ExtensionUIContext): void {
		let adapter = this.uiAdapters.get(ui);
		if (!adapter) {
			const setWidget = this.wrapSetWidget(ui);
			adapter = new Proxy(ui, {
				get: (target, key) =>
					key === "setWidget" ? setWidget : target[key as keyof ExtensionUIContext],
			});
			this.uiAdapters.set(ui, adapter);
		}
		super.setUICtx(adapter);
	}

	override toggleCollapse(): void {
		this.compact = !this.compact;
		this.compactTui?.requestRender(true);
	}

	private wrapSetWidget(ui: ExtensionUIContext): ExtensionUIContext["setWidget"] {
		return (key, content, options) => {
			if (key !== "rpiv-todos" || typeof content !== "function") {
				if (key === "rpiv-todos") this.compactTui = undefined;
				ui.setWidget(key, content, options);
				return;
			}
			ui.setWidget(key, (tui, theme) => {
				this.compactTui = tui;
				return this.wrapComponent(content(tui, theme), () => ui.theme);
			}, options);
		};
	}

	private wrapComponent(component: Component, theme: () => Theme): Component {
		return {
			render: (width) => {
				// Render upstream even when collapsed: completed-row tracking and
				// next-turn auto-hide must continue to work in either presentation.
				const lines = component.render(width);
				return this.compact && lines.length > 0
					? [this.renderSummary(theme(), width)]
					: lines;
			},
			invalidate: () => component.invalidate(),
			handleMouse: (event) => {
				if (event.type === "click" && event.button === "left" && event.y === 0) {
					this.toggleCollapse();
					return { handled: true };
				}
				// Do not consume wheel events: fullscreen must still scroll the transcript.
				return component.handleMouse?.(event);
			},
		};
	}

	private renderSummary(theme: Theme, width: number): string {
		const state = getRenderState();
		const tasks = state.tasks.filter((task) => task.status !== "deleted");
		const current = tasks.find((task) => task.status === "in_progress")
			?? tasks.find((task) => task.status === "pending")
			?? tasks.at(-1);
		const counts = selectTodoCounts(state);
		const heading = `Todos (${counts.completed}/${counts.total})`;
		const subject = current?.subject.replace(/\s+/g, " ").trim();
		const color = counts.pending + counts.inProgress > 0 ? "accent" : "dim";
		return truncateToWidth(
			theme.fg(color, heading) + (subject ? ` - ${theme.fg("text", subject)}` : ""),
			width,
			"…",
		);
	}

	override dispose(): void {
		try {
			super.dispose();
		} finally {
			this.compact = false;
			this.compactTui = undefined;
			this.uiAdapters = new WeakMap();
		}
	}
}
