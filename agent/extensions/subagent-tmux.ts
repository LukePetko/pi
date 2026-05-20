import {
	closeSubagentWindow,
	descriptorHash,
	discoverRunningSubagents,
	envConfig,
	renderSubagentPanes,
} from "./lib/subagent-tmux";

export default function subagentTmux(pi: any) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastHash = "";

	async function refresh(force = false) {
		const config = envConfig();
		const panes = discoverRunningSubagents();
		const hash = descriptorHash(panes);
		if (!force && hash === lastHash)
			return `No change (${panes.length} running)`;
		lastHash = hash;
		return renderSubagentPanes(panes, config);
	}

	function stopWatcher() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function startWatcher(ctx?: any) {
		stopWatcher();
		const config = envConfig();
		timer = setInterval(() => {
			refresh(false).catch(() => undefined);
		}, config.refreshMs);
		ctx?.ui?.notify(
			`Subagent pane watcher started (${config.refreshMs}ms)`,
			"info",
		);
	}

	pi.on("session_start", () => {
		if (envConfig().auto) startWatcher();
	});

	pi.on("session_shutdown", () => stopWatcher());

	pi.registerCommand("subagent-panes", {
		description:
			"Show running async subagents in tmux window 9. Usage: /subagent-panes [show|watch|stop|close]",
		handler: (args: string, ctx: any) => {
			const mode = (args.trim() || "show").split(/\s+/)[0];
			if (mode === "show") {
				return refresh(true)
					.then((message) => ctx.ui.notify(message, "info"))
					.catch((error) =>
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"warning",
						),
					);
			}
			if (mode === "watch") {
				startWatcher(ctx);
				return refresh(true)
					.then((message) => ctx.ui.notify(message, "info"))
					.catch((error) =>
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"warning",
						),
					);
			}
			if (mode === "stop") {
				stopWatcher();
				ctx.ui.notify("Subagent pane watcher stopped", "info");
				return;
			}
			if (mode === "close") {
				stopWatcher();
				return closeSubagentWindow(envConfig())
					.then((closed) =>
						ctx.ui.notify(
							closed
								? "Closed subagent tmux window"
								: "Subagent tmux window not open",
							"info",
						),
					)
					.catch((error) =>
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"warning",
						),
					);
			}
			ctx.ui.notify(
				"Usage: /subagent-panes [show|watch|stop|close]",
				"warning",
			);
		},
	});
}
