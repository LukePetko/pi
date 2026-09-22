import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hubRuntimeCommand } from "./pi-hub-web-launcher.ts";
import { ensureClickableNotifierApp, findNotifierApp } from "./macos-notify-click.ts";
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
	const executable = command === "ffmpeg"
		? ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync)
		: ({ qlmanage: "/usr/bin/qlmanage", mv: "/bin/mv", sips: "/usr/bin/sips", iconutil: "/usr/bin/iconutil", chmod: "/bin/chmod", touch: "/usr/bin/touch" } as Record<string, string>)[command];
	if (!executable) throw new Error(`Missing notification asset tool: ${command}`);
	execFileSync(executable, args, { stdio: "ignore", timeout: 10000 });
}

function iconCachePath(source: string): string {
	const safe = source.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return join(CACHE_DIR, `notify-icon-${safe}.png`);
}

function characterKey(source: string): string {
	const name = basename(source)
		.replace(/\.[^.]+$/, "")
		.replace(/^unknown-/, "");
	return Object.keys(CHARACTER_TITLES).find((key) => name.includes(key)) ?? name;
}

export function titleForSource(source?: string): string {
	if (!source) return pick(FALLBACK_TITLES) ?? "Task complete";
	return (
		pick(CHARACTER_TITLES[characterKey(source)] ?? FALLBACK_TITLES) ??
		"Task complete"
	);
}

export function landingIcon(): { icon: string; source: string } | undefined {
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

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rem = seconds % 60;
	return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
}

export interface NotificationPresentation {
	title: string;
	icon?: string;
	executable: string;
	sender: string[];
}

/** Cold image conversion/app installation runs in a bounded worker, never Hub's event loop. */
export function prepareNotificationPresentation(completion: boolean): Promise<NotificationPresentation> {
	const runtime = hubRuntimeCommand();
	return new Promise((resolve, reject) => {
		execFile(runtime.command, [...runtime.args.slice(0, -1), fileURLToPath(import.meta.url), "--prepare", completion ? "completion" : "permission"], {
			timeout: 60000, killSignal: "SIGKILL", maxBuffer: 8192, env: { PATH: "/usr/bin:/bin", HOME },
		}, (error, stdout) => {
			if (error) { reject(error); return; }
			try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
		}).stdin?.end();
	});
}
function prepareInWorker(completion: boolean): NotificationPresentation {
	let executable: string | undefined;
	let sender: string[] = [];
	try {
		ensureNotifierApp();
		executable = ensureClickableNotifierApp({ sourceApp: findNotifierApp("/opt/homebrew/bin:/usr/local/bin:/usr/bin"), app: join(CACHE_DIR, "Pi Notifier.app"), icon: APP_ICON, bundleId: BUNDLE_ID });
		sender = ["-sender", BUNDLE_ID];
	} catch {
		executable = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find(existsSync);
	}
	if (!executable) throw new Error("terminal-notifier is unavailable");
	const landing = completion ? landingIcon() : undefined;
	return { title: completion ? titleForSource(landing?.source) : "Permission needed", icon: landing?.icon, executable, sender };
}
export function notify(
	title: string,
	message: string,
	icon: string | undefined,
	options: { group: string; callback: string; executable: string; sender: string[]; onDelivered?: (error?: Error | null) => void },
): () => void {
	const args = ["-title", title, "-message", message, "-sound", "Glass", ...options.sender, "-execute", options.callback];
	if (icon) args.push("-contentImage", icon);
	args.push("-group", options.group);
	execFile(options.executable, args, { timeout: 10000 }, (error) => {
		options.onDelivered?.(error);
		if (error) console.error("Pi macOS notification failed:", error.message);
	}).stdin?.end();
	return () => {
		execFile(options.executable, ["-remove", options.group, ...options.sender], { timeout: 10000 }, () => {}).stdin?.end();
	};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] !== "--prepare" || !["completion", "permission"].includes(process.argv[3])) throw new Error("Invalid presentation worker request");
		process.stdout.write(JSON.stringify(prepareInWorker(process.argv[3] === "completion")));
	} catch { process.exitCode = 1; }
}
