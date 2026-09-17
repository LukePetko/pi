import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativePermissionApp, runNativePermissionApp, type NativePermissionApp } from "./native-permission-app.ts";
import { processBirth, type NativePermissionRecord } from "./native-permission-action.ts";
import type { ShowNotice } from "./permission-notifications.ts";

interface SenderOptions {
	prepare?: () => Promise<NativePermissionApp>;
	run?: typeof runNativePermissionApp;
	birth?: typeof processBirth;
	fallback?: ShowNotice;
	report?: (error: unknown) => void;
}

/** Setup and delivery are asynchronous: permission UI never waits for compilation or macOS consent. */
export function createNativePermissionSender(options: SenderOptions = {}): ShowNotice {
	const prepare = options.prepare ?? ensureNativePermissionApp;
	const run = options.run ?? runNativePermissionApp;
	const birth = options.birth ?? processBirth;
	const report = options.report ?? ((error) => console.error("Pi native permission notification:", error));
	return (notice, group, delivered) => {
		const id = randomUUID();
		let app: NativePermissionApp | undefined;
		let cancelled = false;
		let removeFallback: (() => void) | undefined;
		async function remove(): Promise<void> {
			if (!app) return;
			// Revoke click capability before asking macOS to clear the visible alert.
			await unlink(join(app.records, `${id}.json`)).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
			await run(app, "remove", id);
		}
		async function send(): Promise<void> {
			app = await prepare();
			if (cancelled) return;
			const path = join(app.records, `${id}.json`);
			const record: NativePermissionRecord = {
				version: 1,
				title: "Permission needed",
				body: `${basename(notice.cwd) || notice.cwd} · ${notice.title}`,
				actionable: Boolean(notice.broker),
				callback: {
					executable: process.execPath,
					arguments: [
						...(process.versions.bun ? [] : ["--experimental-strip-types"]),
						fileURLToPath(new URL("./native-permission-action.ts", import.meta.url)), path,
					],
					environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TMUX ? { TMUX: process.env.TMUX } : {}) },
				},
				target: { pid: process.pid, startedAt: birth(process.pid) },
				...(notice.broker ? { broker: notice.broker } : {}),
			};
			const temporary = `${path}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
				await rename(temporary, path);
			} finally { await unlink(temporary).catch(() => {}); }
			if (cancelled) { await remove(); return; }
			await run(app, "show", id);
		}
		void send().catch(async (error) => {
			await remove().catch(report);
			if (!cancelled) {
				report(error);
				removeFallback = options.fallback?.(notice, group, delivered);
			}
		}).finally(delivered).catch(report);
		return () => {
			cancelled = true;
			removeFallback?.();
			void remove().catch(report);
		};
	};
}
