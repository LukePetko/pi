import { execFile, execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubRuntimeCommand } from "./pi-hub-web-launcher.ts";
import { focusPiSession } from "./pi-hub-navigation.ts";
import { originCommand } from "./hub-notification-origin.ts";
import { parseOrigin, type NotificationOrigin } from "./hub-notification-protocol.ts";

/** Navigation's synchronous probes run only in this cancellable bounded worker, never Hub HTTP. */
export async function focusNotificationOrigin(origin: NotificationOrigin, signal: AbortSignal): Promise<void> {
	const runtime = hubRuntimeCommand();
	await new Promise<void>((resolve, reject) => {
		execFile(runtime.command, [...runtime.args.slice(0, -1), fileURLToPath(import.meta.url), JSON.stringify(origin)], {
			timeout: 10000, killSignal: "SIGKILL", maxBuffer: 8192, signal,
			env: { PATH: "/usr/bin:/bin" },
		}, (error) => error ? reject(error) : resolve()).stdin?.end();
	});
}
function focusWorker(origin: NotificationOrigin) {
	const run = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin" } }).trim();
	if (run("/bin/ps", ["-p", String(origin.pid), "-o", "lstart="]) !== origin.birth || Number(run("/bin/ps", ["-p", String(origin.pid), "-o", "uid="])) !== process.getuid?.()) throw new Error("Origin replaced before focus");
	if (origin.tmuxSocket) {
		const socket = lstatSync(origin.tmuxSocket);
		if (!socket.isSocket() || socket.uid !== process.getuid?.() || realpathSync(origin.tmuxSocket) !== origin.tmuxSocket) throw new Error("Origin socket replaced before focus");
	}
	focusPiSession(origin.pid, (command, args) => {
		const call = originCommand(origin, command, args);
		return run(call.executable, call.args);
	});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { focusWorker(parseOrigin(JSON.parse(process.argv[2]))); }
	catch { process.exitCode = 1; }
}
