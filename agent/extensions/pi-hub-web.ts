import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startHubWeb, stopHubWeb } from "./lib/pi-hub-web-launcher.ts";

export default function piHubWeb(pi: ExtensionAPI): void {
	pi.registerCommand("hub-web", {
		description: "Open the local web Hub, or stop its server with /hub-web stop",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/hub-web requires an interactive terminal", "warning");
				return;
			}
			if (args.trim() && args.trim() !== "stop") {
				ctx.ui.notify("Usage: /hub-web [stop]", "warning");
				return;
			}
			try {
				if (args.trim() === "stop") {
					const stopped = await stopHubWeb();
					ctx.ui.notify(stopped ? "Web Hub stopped; automatic startup disabled" : "Web Hub is stopped; automatic startup disabled", "info");
					return;
				}
				const endpoint = await startHubWeb();
				// Fragment credentials never enter HTTP request URLs or the transcript.
				const url = `${endpoint.origin}/#${endpoint.token}`;
				const result = await pi.exec(process.platform === "darwin" ? "open" : "xdg-open", [url], { timeout: 5_000 });
				if (result.code !== 0 || result.killed) throw new Error("Could not open the default browser");
				ctx.ui.notify(`Web Hub opened at ${endpoint.origin}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Could not open Web Hub", "error");
			}
		},
	});
}
