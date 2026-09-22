import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicPrivateJson, withHubControl } from "./pi-hub-service-control.ts";
import { ensureNativePermissionApp, nativePermissionRoot, runNativePermissionApp, type NativePermissionApp } from "./native-permission-app.ts";
import { hubRuntimeCommand } from "./pi-hub-web-launcher.ts";
import { notify, prepareNotificationPresentation, formatDuration } from "./hub-notification-presentation.ts";
import type { HubNotice, NotificationSender } from "./hub-notifications.ts";
import { basename } from "node:path";

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
/** terminal-notifier reads stdin to EOF even for list/remove operations. */
export function runTerminalNotification(executable: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, args, { timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)).stdin?.end();
	});
}
/** One user-wide native host; every routing record remains scoped by random ID + owner. */
export function createHubNotificationSender(endpointFile: string, options: {
	root?: string;
	prepare?: () => Promise<NativePermissionApp>;
	run?: typeof runNativePermissionApp;
	notify?: typeof notify;
	presentation?: typeof prepareNotificationPresentation;
	terminalRemove?: (id: string) => Promise<void>;
	terminalList?: () => Promise<string[]>;
	report?: (message: string) => void;
} = {}): NotificationSender {
	const root = options.root ?? nativePermissionRoot();
	const records = join(root, "requests");
	const prepare = options.prepare ?? (() => withHubControl(root, () => ensureNativePermissionApp()));
	const run = options.run ?? runNativePermissionApp;
	const sendTerminal = options.notify ?? notify;
	let app: NativePermissionApp | undefined;
	const runtime = hubRuntimeCommand();
	const callback = fileURLToPath(new URL("./hub-notification-action.ts", import.meta.url));
	async function revoke(n: HubNotice) {
		const path = join(records, `${n.id}.json`);
		const record = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
		if (record && record.owner !== n.owner) throw new Error("Notification record belongs to another scope");
		await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
	}
	async function remove(n: HubNotice) {
		await revoke(n);
		if (n.backend === "terminal") {
			if (options.terminalRemove) { await options.terminalRemove(n.id); return; }
			const custom = join(homedir(), ".pi", "agent", "cache", "Pi Notifier.app", "Contents", "MacOS", "terminal-notifier");
			for (const executable of [custom, "/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].filter(existsSync)) {
				const args = ["-remove", n.id, ...(executable === custom ? ["-sender", "works.earendil.pi-notifier.lukas"] : [])];
				await runTerminalNotification(executable, args);
			}
		} else {
			app ??= await prepare();
			await run(app, "remove", n.id);
		}
	}
	return {
		async show(n, _origin, live, fallback) {
			if (n.backend === "native") {
				try { app ??= await prepare(); }
				catch {
					(options.report ?? console.error)("Native preparation failed; using removable Show-only notification");
					if (!(await fallback())) return;
				}
			}
			if (!live()) return;
			await mkdir(records, { recursive: true, mode: 0o700 });
			const path = join(records, `${n.id}.json`);
			const args = [...runtime.args.slice(0, -1), callback, path];
			const record = {
				version: 1, resident: true, owner: n.owner, id: n.id, endpointFile, capability: n.capability,
				title: "Permission needed", body: `${basename(n.event.cwd!) || n.event.cwd} · ${n.event.title}`,
				actionable: Boolean(n.event.requestId) && !n.showOnly,
				callback: { executable: runtime.command, arguments: args, environment: { PATH: "/usr/bin:/bin" } },
			};
			await atomicPrivateJson(path, record);
			if (!live()) { await remove(n); return; }
			if (n.backend === "terminal") {
				const completion = n.event.kind === "completion";
				const presentation = await withHubControl(root, () => (options.presentation ?? prepareNotificationPresentation)(completion));
				if (!live()) { await remove(n); return; }
				await new Promise<void>((resolve, reject) => {
					sendTerminal(presentation.title, completion ? `${basename(n.event.cwd!) || n.event.cwd} · ${n.event.test ? "test" : n.event.durationMs === undefined ? "done" : formatDuration(n.event.durationMs)}` : record.body, presentation.icon, {
						group: n.id, callback: [runtime.command, ...args, "show"].map(quote).join(" "), executable: presentation.executable, sender: presentation.sender, onDelivered: (error) => error ? reject(error) : resolve(),
					});
				});
			} else await run(app!, "show", n.id);
			if (!live()) await remove(n);
		},
		revoke, remove,
		async list(notices) {
			const ids: string[] = [];
			if (notices.some(n => n.backend === "native")) {
				app ??= await prepare();
				const value = JSON.parse(await run(app, "list"));
				ids.push(...value.delivered, ...value.pending);
			}
			if (notices.some(n => n.backend === "terminal")) {
				if (options.terminalList) return [...ids, ...await options.terminalList()];
				const custom = join(homedir(), ".pi", "agent", "cache", "Pi Notifier.app", "Contents", "MacOS", "terminal-notifier");
				for (const executable of [custom, "/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].filter(existsSync)) {
					const stdout = await runTerminalNotification(executable, ["-list", "ALL", ...(executable === custom ? ["-sender", "works.earendil.pi-notifier.lukas"] : [])]);
					ids.push(...(stdout.match(/[a-f0-9-]{36}/g) ?? []));
				}
			}
			return ids;
		},
	};
}
