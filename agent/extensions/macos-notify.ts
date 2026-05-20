import { execFile, execFileSync } from "node:child_process";
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

function projectName(ctx?: ExtensionContext): string {
	return ctx?.cwd ? basename(ctx.cwd) || ctx.cwd : "pi";
}

function notify(title: string, message: string, icon?: string): void {
	try {
		ensureNotifierApp();
	} catch {
		// Fall back to terminal-notifier's default sender if app generation fails.
	}
	const args = ["-title", title, "-message", message, "-sound", "Glass"];
	if (existsSync(APP_PATH)) args.push("-sender", BUNDLE_ID);
	if (icon) args.push("-contentImage", icon);
	execFile("terminal-notifier", args, (error) => {
		if (!error) return;
		const script = [
			`tell application "System Events"`,
			`display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`,
			`end tell`,
		].join("\n");
		execFile("osascript", ["-e", script], () => {});
	});
}

export default function (pi: ExtensionAPI) {
	let startedAt = 0;
	let lastCtx: ExtensionContext | undefined;

	pi.on("agent_start", async (_event, ctx) => {
		startedAt = Date.now();
		lastCtx = ctx;
	});

	function done(ctx = lastCtx): void {
		const elapsed = startedAt ? formatDuration(Date.now() - startedAt) : "done";
		const landing = landingIcon();
		notify(
			titleForSource(landing?.source),
			`${projectName(ctx)} · ${elapsed}`,
			landing?.icon,
		);
		startedAt = 0;
	}

	pi.on("agent_end", async (_event, ctx) => done(ctx));

	pi.registerCommand("notify-test", {
		description: "Send a test macOS notification",
		handler: async (_args, ctx) => {
			const landing = landingIcon();
			notify(
				titleForSource(landing?.source),
				`${projectName(ctx)} · test`,
				landing?.icon,
			);
			ctx.ui.notify("Sent macOS notification test", "info");
		},
	});
}
