/**
 * Compare ~/.pi's Git HEAD with the revision loaded by this runtime every 30s.
 * Only committed changes count; no fetch, automatic reload, or hub dependency.
 * A widget is used because our custom footer hides standard extension statuses.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const WIDGET = "config-revision";
const POLL_MS = 30_000;
const UPDATED = "↻ Config updated · /reload";
const UNKNOWN = "↻ Config revision unknown · /reload";

interface RevisionMonitor {
	controller: AbortController;
	timer?: ReturnType<typeof setInterval>;
	checking: boolean;
	baseline?: string;
}

export default function configRevision(pi: ExtensionAPI): void {
	const configRepo = join(homedir(), ".pi");
	let active: RevisionMonitor | undefined;

	async function readHead(signal: AbortSignal): Promise<string | undefined> {
		try {
			const result = await pi.exec(
				"git",
				["-C", configRepo, "rev-parse", "--verify", "HEAD"],
				{ timeout: 5_000, signal },
			);
			const head = result.stdout.trim();
			if (result.code === 0 && !result.killed && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) {
				return head;
			}
		} catch {
			// Missing Git/repo, cancellation, or transient failures must not break Pi.
		}
		return undefined;
	}

	function stop(): void {
		const previous = active;
		active = undefined;
		if (previous?.timer) clearInterval(previous.timer);
		previous?.controller.abort();
	}

	async function poll(monitor: RevisionMonitor, ctx: ExtensionContext): Promise<void> {
		if (active !== monitor || monitor.checking) return;
		monitor.checking = true;
		try {
			const current = await readHead(monitor.controller.signal);
			if (active !== monitor || !current || current === monitor.baseline) return;
			// Latch until resources reload, including if HEAD later moves back.
			ctx.ui.setWidget(WIDGET, [ctx.ui.theme.fg("warning", UPDATED)]);
			if (monitor.timer) clearInterval(monitor.timer);
			monitor.timer = undefined;
		} finally {
			monitor.checking = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setWidget(WIDGET, undefined);
		const monitor: RevisionMonitor = {
			controller: new AbortController(),
			checking: false,
		};
		active = monitor;
		monitor.baseline = await readHead(monitor.controller.signal);
		if (active !== monitor) return;
		if (!monitor.baseline) {
			// A later read cannot tell us what was loaded; require a fresh reload.
			ctx.ui.setWidget(WIDGET, [ctx.ui.theme.fg("warning", UNKNOWN)]);
			return;
		}
		monitor.timer = setInterval(() => void poll(monitor, ctx), POLL_MS);
		monitor.timer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		if (ctx.hasUI && ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
	});
}
