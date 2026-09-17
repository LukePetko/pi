import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { CommandRunner } from "./pi-hub-navigation.ts";

const REGISTER_APP =
	"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function run(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

/** Homebrew exposes a shell wrapper; notification activation needs the whole app. */
export function findNotifierApp(path = process.env.PATH ?? ""): string {
	for (const directory of path.split(delimiter).filter(Boolean)) {
		try {
			const executable = realpathSync(join(directory, "terminal-notifier"));
			const candidates = [
				dirname(dirname(dirname(executable))),
				join(dirname(dirname(executable)), "terminal-notifier.app"),
			];
			for (const candidate of candidates) {
				if (
					candidate.endsWith(".app") &&
					existsSync(join(candidate, "Contents", "MacOS", "terminal-notifier"))
				) return candidate;
			}
		} catch {
			// Try the next PATH entry.
		}
	}
	throw new Error("Could not locate terminal-notifier.app");
}

/** Keep generated binaries out of Git and retain the existing notification identity. */
export function ensureClickableNotifierApp(
	{ sourceApp, app, icon, bundleId }: {
		sourceApp: string;
		app: string;
		icon: string;
		bundleId: string;
	},
	runner: CommandRunner = run,
): string {
	const executable = join(app, "Contents", "MacOS", "terminal-notifier");
	if (!existsSync(executable)) {
		mkdirSync(dirname(app), { recursive: true });
		const temporary = mkdtempSync(join(dirname(app), "pi-notifier-"));
		const staged = join(temporary, "Pi Notifier.app");
		try {
			cpSync(sourceApp, staged, { recursive: true });
			const plist = join(staged, "Contents", "Info.plist");
			for (const [key, value] of [
				["CFBundleIdentifier", bundleId],
				["CFBundleName", "Pi Notifier"],
				["CFBundleIconFile", "AppIcon"],
				["NSUserNotificationAlertStyle", "alert"],
			]) {
				runner("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
			}
			copyFileSync(icon, join(staged, "Contents", "Resources", "AppIcon.icns"));
			runner("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", staged]);
			try {
				renameSync(staged, app);
			} catch (error) {
				// Another Pi session may have finished the same atomic installation.
				if (!existsSync(executable)) throw error;
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
	runner(REGISTER_APP, ["-f", app]);
	return executable;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The notification stores a command, not a pane snapshot, so moved panes still work. */
export function notificationFocusCommand(
	pid: number,
	startedAt: string,
): string {
	if (!Number.isSafeInteger(pid) || pid <= 0 || !startedAt.trim()) {
		throw new Error("A live Pi process identity is required");
	}
	const navigation = new URL("./pi-hub-navigation.ts", import.meta.url).href;
	const script = [
		`import { execFileSync } from "node:child_process";`,
		`import { focusPiSession } from ${JSON.stringify(navigation)};`,
		`try {`,
		`const startedAt = execFileSync("/bin/ps", ["-p", "${pid}", "-o", "lstart="], { encoding: "utf8" }).trim();`,
		// A persistent notification must never jump to a recycled PID.
		`if (startedAt === ${JSON.stringify(startedAt.trim())}) focusPiSession(${pid});`,
		`} catch { process.exitCode = 1; }`,
	].join("\n");
	return [
		"/usr/bin/env",
		`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`,
		...(process.env.TMUX ? [`TMUX=${process.env.TMUX}`] : []),
		process.execPath,
		...(process.versions.bun ? [] : ["--experimental-strip-types"]),
		"--input-type=module",
		"--eval",
		script,
	].map(shellQuote).join(" ");
}
