import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { findTmuxPaneForPid, parseProcessParents, parseTmuxPanes } from "./pi-hub-navigation.ts";
import { isPiSessionFocused } from "./pi-notification-focus.ts";
import { inspectPermission, decidePermission } from "./hub-permissions.ts";
import type { HubSource } from "./pi-hub-web-server.ts";
import { NotificationError, type NotificationOrigin } from "./hub-notification-protocol.ts";
import { focusNotificationOrigin } from "./hub-notification-focus.ts";

const execute = promisify(execFile);
// Executables belong to the service, never to producer-controlled PATH or callback data.
const tools: Record<string, string | undefined> = {
	ps: "/bin/ps",
	tmux: ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync),
	aerospace: ["/opt/homebrew/bin/aerospace", "/usr/local/bin/aerospace"].find(existsSync),
};
export function originCommand(origin: NotificationOrigin, command: string, args: string[]) {
	const executable = tools[command];
	if (!executable) throw new Error(`Notification focus tool unavailable: ${command}`);
	return { executable, args: command === "tmux" && origin.tmuxSocket ? ["-S", origin.tmuxSocket, ...args] : args };
}
async function run(command: string, args: string[]): Promise<string> {
	return (await execute(command, args, { timeout: 1500, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin" } })).stdout.trim();
}
function processExists(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error.code === "ESRCH" ? false : undefined;
	}
}
export function notificationOriginAuthority(source: HubSource, directory: string, dependencies: { run: typeof run; focus: typeof focusNotificationOrigin; processExists?: typeof processExists } = {
	run, focus: focusNotificationOrigin,
}) {
	function originRun(origin: NotificationOrigin) {
		return (command: string, args: string[]) => {
			const call = originCommand(origin, command, args);
			return dependencies.run(call.executable, call.args);
		};
	}
	async function validate(origin: NotificationOrigin, requestId?: string): Promise<void> {
		let birth: string;
		let uid: number;
		try {
			const values = await Promise.all([
				dependencies.run("/bin/ps", ["-p", String(origin.pid), "-o", "lstart="]),
				dependencies.run("/bin/ps", ["-p", String(origin.pid), "-o", "uid="]),
			]);
			birth = values[0].trim(); uid = Number(values[1].trim());
		} catch { throw new NotificationError(409, "Origin process unavailable"); }
		if (!birth || birth !== origin.birth || uid !== process.getuid?.()) throw new NotificationError(409, "Origin process replaced");
		if (origin.broker) {
			if (!source.snapshot().connected) throw new NotificationError(503, "Broker disconnected");
			const live = await source.resolveSession(origin.broker.id);
			if (!live) throw new NotificationError(425, "Origin broker registration unavailable");
			if (live.pid !== origin.pid) throw new NotificationError(409, "Origin broker registration replaced");
			if (live.startedAt !== origin.broker.startedAt || live.endpointEpoch !== origin.broker.endpointEpoch) throw new NotificationError(425, "Origin broker binding needs revalidation");
		}
		if (origin.tmuxSocket) {
			const socket = await lstat(origin.tmuxSocket).catch(() => undefined);
			if (!socket?.isSocket() || socket.uid !== uid || await realpath(origin.tmuxSocket) !== origin.tmuxSocket) throw new NotificationError(409, "Invalid originating tmux socket");
			const runner = originRun(origin);
			const [panes, processes] = await Promise.all([
				runner("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}"]),
				runner("ps", ["-axo", "pid=,ppid="]),
			]);
			if (!findTmuxPaneForPid(origin.pid, parseTmuxPanes(panes), parseProcessParents(processes))) throw new NotificationError(409, "tmux socket does not own Pi");
		}
		if (requestId) {
			if (!origin.broker) throw new NotificationError(409, "Actionable notification requires a broker binding");
			try { await inspectPermission({ id: origin.broker.id, pid: origin.pid }, requestId, directory); }
			catch (error: any) { throw new NotificationError(error.status === 503 ? 503 : 409, "Permission gate unavailable"); }
		}
	}
	return {
		validate,
		async runtimeLiveness(origin: NotificationOrigin): Promise<"live" | "dead" | "unknown"> {
			// Broker, gate and tmux failures are not evidence of process death.
			try {
				const exists = (dependencies.processExists ?? processExists)(origin.pid);
				if (exists === false) return "dead";
				if (exists !== true) return "unknown";
				const [birthValue, uidValue] = await Promise.all([
					dependencies.run("/bin/ps", ["-p", String(origin.pid), "-o", "lstart="]),
					dependencies.run("/bin/ps", ["-p", String(origin.pid), "-o", "uid="]),
				]);
				const birth = birthValue.trim(), uid = uidValue.trim();
				if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(birth) ||
					!Number.isFinite(Date.parse(birth)) || !/^\d+$/.test(uid) ||
					!Number.isSafeInteger(Number(uid)) || process.getuid?.() === undefined)
					return "unknown";
				return birth === origin.birth && Number(uid) === process.getuid?.() ? "live" : "dead";
			} catch {
				return "unknown";
			}
		},
		focused: (origin: NotificationOrigin) => isPiSessionFocused(origin.pid, originRun(origin)),
		async action(origin: NotificationOrigin, requestId: string | undefined, action: "show" | "accept" | "reject", current = () => true, signal = new AbortController().signal) {
			await validate(origin, requestId);
			if (!current() || signal.aborted) throw new NotificationError(409, "Native action revoked");
			if (action === "show") { await dependencies.focus(origin, signal); return; }
			if (!requestId || !origin.broker) throw new NotificationError(409, "Show-only notification");
			// Roster registration time is not the independent gate owner's lifetime.
			await decidePermission({ id: origin.broker.id, pid: origin.pid }, requestId, action === "accept" ? "once" : "reject", directory, { current, signal });
		},
	};
}
