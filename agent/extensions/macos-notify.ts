import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	ensureClickableNotifierApp,
	findNotifierApp,
	notificationFocusCommand,
} from "./lib/macos-notify-click.ts";
import { watchPermissionNotifications, type ShowNotice } from "./lib/permission-notifications.ts";
import { createNativePermissionSender } from "./lib/native-permission-notifications.ts";
import { createFocusNotifications } from "./lib/focus-notifications.ts";
import { isPiSessionFocused } from "./lib/pi-notification-focus.ts";

const HOME = process.env.HOME ?? ".";
const AGENT_DIR = join(HOME, ".pi", "agent");
const LANDING_DIR = join(AGENT_DIR, "landing");
const CACHE_DIR = join(AGENT_DIR, "cache");
const APP_PATH = join(AGENT_DIR, "Pi Notifier.app");
const APP_EXECUTABLE = join(APP_PATH, "Contents", "MacOS", "Pi Notifier");
const APP_ICONSET = join(CACHE_DIR, "pi-notifier.iconset");
const APP_ICON = join(APP_PATH, "Contents", "Resources", "AppIcon.icns");
const PI_LOGO_SVG = join(AGENT_DIR, "assets", "pi-logo.svg");
const BUNDLE_ID = "works.earendil.pi-notifier.lukas";

const CHARACTER_TITLES: Record<string, string[]> = {
	frieren: ["Frieren finished the quest", "Frieren says the task was brief"],
	maomao: ["Maomao solved the case", "Maomao found the right reagent"],
	"yor-forger": ["Yor cleaned up the mission", "Yor handled the assignment"],
	bocchi: ["Bocchi survived the task", "Bocchi made it through the request"],
	"kana-arima": ["Kana nailed the scene", "Kana wrapped the take"],
	"nijika-ijichi": ["Nijika kept the band on tempo", "Nijika says we're done"],
	"akane-tendo": ["Akane landed the final hit", "Akane wrapped the session"],
	"misa-amane": ["Misa delivered the message", "Misa says mission complete"],
	fern: ["Fern finished the assignment", "Fern says the task is complete"],
	"marin-kitagawa": ["Marin finished the fit check", "Marin says we're done"],
	"yumeko-jabami": ["Yumeko won the gamble", "Yumeko called the task"],
	shampoo: ["Shampoo bounced back with results", "Shampoo says done"],
	"ruka-sarashina": ["Ruka's heart cleared the task", "Ruka wrapped it up"],
	"mai-sakurajima": ["Mai stepped off stage", "Mai finished the scene"],
	"chizuru-ichinose": [
		"Chizuru wrapped the rental",
		"Chizuru finished the scene",
	],
	"kinme-wakana": [
		"Wakana finished the laundry run",
		"Wakana cleaned up the task",
	],
	"miyo-saimori": ["Miyo found a quiet ending", "Miyo completed the request"],
	"miyu-suzuki": ["Miyu signed off softly", "Miyu finished the task"],
	"nanakusa-nazuna": [
		"Nazuna owned the night shift",
		"Nazuna finished before sunrise",
	],
	"kaoruko-waguri": [
		"Kaoruko sweetened the ending",
		"Kaoruko finished the task with grace",
	],
	shisui: [
		"Shisui brewed the right remedy",
		"Shisui handled the rear palace errand",
	],
};
const FALLBACK_TITLES = [
	"The shikigami returned",
	"Plus Ultra, task complete",
	"The One Piece was context",
	"Your anime arc is complete",
];

function pick<T>(items: T[]): T | undefined {
	return items[Math.floor(Math.random() * items.length)];
}

function run(command: string, args: string[]): void {
	execFileSync(command, args, { stdio: "ignore" });
}

function iconCachePath(source: string): string {
	const safe = source.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return join(CACHE_DIR, `notify-icon-${safe}.png`);
}

function characterKey(source: string): string {
	const name = basename(source)
		.replace(/\.[^.]+$/, "")
		.replace(/^unknown-/, "");
	return (
		Object.keys(CHARACTER_TITLES).find((key) => name.includes(key)) ?? name
	);
}

function titleForSource(source?: string): string {
	if (!source) return pick(FALLBACK_TITLES) ?? "Task complete";
	return (
		pick(CHARACTER_TITLES[characterKey(source)] ?? FALLBACK_TITLES) ??
		"Task complete"
	);
}

function landingIcon(): { icon: string; source: string } | undefined {
	try {
		const files = readdirSync(LANDING_DIR)
			.filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
			.map((name) => join(LANDING_DIR, name))
			.filter((path) => existsSync(path));
		const source = pick(files);
		if (!source) return undefined;
		const cached = iconCachePath(source);
		if (existsSync(cached)) return { icon: cached, source };
		mkdirSync(CACHE_DIR, { recursive: true });
		run("ffmpeg", [
			"-y",
			"-i",
			source,
			"-vf",
			"scale=256:256:force_original_aspect_ratio=decrease,pad=256:256:(ow-iw)/2:(oh-ih)/2",
			cached,
		]);
		return { icon: existsSync(cached) ? cached : source, source };
	} catch {
		return undefined;
	}
}

function ensureNotifierApp(): void {
	if (existsSync(APP_EXECUTABLE) && existsSync(APP_ICON)) return;

	const contents = join(APP_PATH, "Contents");
	const macos = join(contents, "MacOS");
	const resources = join(contents, "Resources");
	mkdirSync(macos, { recursive: true });
	mkdirSync(resources, { recursive: true });
	mkdirSync(APP_ICONSET, { recursive: true });

	const svg = join(CACHE_DIR, "pi-notifier.svg");
	const png = join(CACHE_DIR, "pi-notifier-1024.png");
	writeFileSync(svg, readFileSync(PI_LOGO_SVG, "utf8"));
	run("qlmanage", ["-t", "-s", "1024", "-o", CACHE_DIR, svg]);
	const generated = join(CACHE_DIR, "pi-notifier.svg.png");
	if (existsSync(generated)) run("mv", [generated, png]);

	for (const size of [16, 32, 128, 256, 512]) {
		run("sips", [
			"-z",
			String(size),
			String(size),
			png,
			"--out",
			join(APP_ICONSET, `icon_${size}x${size}.png`),
		]);
		run("sips", [
			"-z",
			String(size * 2),
			String(size * 2),
			png,
			"--out",
			join(APP_ICONSET, `icon_${size}x${size}@2x.png`),
		]);
	}
	run("iconutil", ["-c", "icns", APP_ICONSET, "-o", APP_ICON]);

	writeFileSync(
		join(contents, "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Pi Notifier</string>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>Pi Notifier</string>
<key>CFBundleDisplayName</key><string>Pi Notifier</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSBackgroundOnly</key><string>1</string>
<key>NSUserNotificationAlertStyle</key><string>alert</string>
</dict></plist>\n`,
	);
	writeFileSync(APP_EXECUTABLE, "#!/bin/sh\nexit 0\n");
	run("chmod", ["+x", APP_EXECUTABLE]);
	run("touch", [APP_PATH]);
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = seconds % 60;
	return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

function projectName(ctx?: Pick<ExtensionContext, "cwd">): string {
	return ctx?.cwd ? basename(ctx.cwd) || ctx.cwd : "pi";
}

let clickableNotifier: string | undefined;

function notify(
	title: string,
	message: string,
	icon: string | undefined,
	options: { group: string; onDelivered?: () => void },
): () => void {
	const args = ["-title", title, "-message", message, "-sound", "Glass"];
	try {
		if (!clickableNotifier) {
			ensureNotifierApp();
			clickableNotifier = ensureClickableNotifierApp({
				sourceApp: findNotifierApp(),
				app: join(CACHE_DIR, "Pi Notifier.app"),
				icon: APP_ICON,
				bundleId: BUNDLE_ID,
			});
		}
		// The sender now owns a real notification handler, rather than an exit-only stub.
		args.push("-sender", BUNDLE_ID);
	} catch {
		// Default terminal-notifier can still handle clicks if custom app setup fails.
	}
	try {
		const startedAt = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
			encoding: "utf8",
		}).trim();
		args.push("-execute", notificationFocusCommand(process.pid, startedAt));
	} catch {
		// Do not lose the notification if process identity cannot be captured.
	}
	if (icon) args.push("-contentImage", icon);
	args.push("-group", options.group);
	const executable = clickableNotifier ?? "terminal-notifier";
	const sender = clickableNotifier ? ["-sender", BUNDLE_ID] : [];
	execFile(executable, args, (error) => {
		options.onDelivered?.();
		// AppleScript alerts cannot be withdrawn when their Pi session gains focus.
		if (error) console.error("Pi macOS notification failed:", error.message);
	});
	return () => {
		execFile(executable, ["-remove", options.group, ...sender], () => {}).stdin?.end();
	};
}

export const legacyPermissionSender: ShowNotice = (notice, group, onDelivered) =>
	notify("Permission needed", `${projectName(notice)} · ${notice.title}`, undefined, { group, onDelivered });

export default function (
	pi: ExtensionAPI,
	permissionSender: ShowNotice = createNativePermissionSender({ fallback: legacyPermissionSender }),
	isFocused: () => Promise<boolean> = () => isPiSessionFocused(process.pid),
) {
	let startedAt = 0;
	let lastCtx: ExtensionContext | undefined;
	let stopPermissions: (() => void) | undefined;
	let notifications = createFocusNotifications({ isFocused });

	pi.on("session_start", () => {
		stopPermissions?.();
		notifications.dispose();
		notifications = createFocusNotifications({ isFocused });
		stopPermissions = watchPermissionNotifications(pi.events, (notice, group, onDelivered) =>
			notifications.show(delivered => permissionSender(notice, group, () => {
				delivered();
				onDelivered();
			})));
	});
	pi.on("session_shutdown", () => {
		stopPermissions?.();
		stopPermissions = undefined;
		notifications.dispose();
	});

	pi.on("agent_start", async (_event, ctx) => {
		startedAt = Date.now();
		lastCtx = ctx;
	});

	function completion(message: string): void {
		const group = `pi-completion:${process.pid}:${randomUUID()}`;
		notifications.show(onDelivered => {
			const landing = landingIcon();
			return notify(titleForSource(landing?.source), message, landing?.icon, { group, onDelivered });
		});
	}

	function done(ctx = lastCtx): void {
		const elapsed = startedAt ? formatDuration(Date.now() - startedAt) : "done";
		completion(`${projectName(ctx)} · ${elapsed}`);
		startedAt = 0;
	}

	pi.on("agent_end", async (_event, ctx) => done(ctx));

	pi.registerCommand("notify-test", {
		description: "Test macOS notifications (suppressed while this Pi is focused)",
		handler: async (_args, ctx) => {
			completion(`${projectName(ctx)} · test`);
			ctx.ui.notify("Notification queued; skipped if this Pi is already focused", "info");
		},
	});
}
