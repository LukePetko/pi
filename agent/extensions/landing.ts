import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const LANDING_DIR = join(process.env.HOME ?? ".", ".pi", "agent", "landing");
const FALLBACK_IMAGE_PATH = "/Users/lukaspetko/Downloads/6Sz0NJiw_400x400.jpg";
const WIDGET_ID = "landing";

// Sharper than half-blocks, but less noisy than braille.
const CHAFA_ARGS = [
	"--format=symbols",
	"--symbols=quad",
	"--colors=truecolor",
	"--color-space=din99d",
	"--dither=none",
	"--preprocess=on",
	"--work=9",
	"--size=60x22",
];

type Rgb = [number, number, number];
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
	[236, 72, 153],
	[168, 85, 247],
	[125, 211, 252],
	[244, 214, 255],
	[125, 211, 252],
	[168, 85, 247],
];

function mix(a: number, b: number, t: number): number {
	return Math.round(a + (b - a) * t);
}

function colorAt(position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * PALETTE.length;
	const index = Math.floor(scaled);
	const next = (index + 1) % PALETTE.length;
	const t = scaled - index;
	const a = PALETTE[index]!;
	const b = PALETTE[next]!;
	return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function fg([r, g, b]: Rgb, text: string): string {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function gradient(text: string, phase = 0): string {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars
		.map((char, index) =>
			char === " " ? char : fg(colorAt(index / span + phase), char),
		)
		.join("");
}

function center(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return text;
	return `${" ".repeat(Math.floor((width - visible) / 2))}${text}`;
}

function imageFiles(): string[] {
	try {
		return readdirSync(LANDING_DIR)
			.filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name))
			.sort()
			.map((name) => join(LANDING_DIR, name));
	} catch {
		return [];
	}
}

function currentImage(): string {
	const files = imageFiles();
	if (files.length === 0) return FALLBACK_IMAGE_PATH;
	return files[Math.floor(Math.random() * files.length)]!;
}

function imageCachePath(imagePath: string): string {
	const safe = imagePath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return join(
		process.env.HOME ?? ".",
		".pi",
		"agent",
		"cache",
		`waifu-nocrop-v1-${safe}.ansi`,
	);
}

function processedImagePath(imagePath: string): string {
	const safe = imagePath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return join(
		process.env.HOME ?? ".",
		".pi",
		"agent",
		"cache",
		`waifu-nocrop-${safe}.jpg`,
	);
}

function cacheFresh(imagePath: string, cachePath: string): boolean {
	try {
		return (
			existsSync(cachePath) &&
			existsSync(imagePath) &&
			statSync(cachePath).mtimeMs >= statSync(imagePath).mtimeMs
		);
	} catch {
		return false;
	}
}

function stripControls(text: string): string {
	return text
		.replace(/\x1b\[\?25[lh]/g, "")
		.replace(/\x1b\[0m\s*$/g, "\x1b[0m")
		.trimEnd();
}

function prepareImage(imagePath: string, outputPath: string): Promise<string> {
	return new Promise((resolve) => {
		mkdirSync(dirname(outputPath), { recursive: true });
		if (/\.webp$/i.test(imagePath)) {
			execFile(
				"ffmpeg",
				["-y", "-i", imagePath, "-vf", "scale=960:960", outputPath],
				() => resolve(existsSync(outputPath) ? outputPath : imagePath),
			);
			return;
		}

		execFile(
			"sips",
			["--resampleHeightWidth", "960", "960", imagePath, "--out", outputPath],
			() => resolve(existsSync(outputPath) ? outputPath : imagePath),
		);
	});
}

async function renderImage(force = false): Promise<string[]> {
	const imagePath = currentImage();
	const cachePath = imageCachePath(imagePath);
	const outputPath = processedImagePath(imagePath);

	if (!force && cacheFresh(imagePath, cachePath)) {
		return readFileSync(cachePath, "utf8").trimEnd().split("\n");
	}

	const renderPath = await prepareImage(imagePath, outputPath);
	return new Promise((resolve) => {
		execFile(
			"chafa",
			[...CHAFA_ARGS, renderPath],
			{ maxBuffer: 4_000_000 },
			(error, stdout) => {
				const content = error
					? fg(
							[248, 113, 113],
							`Could not render landing image: ${error.message}`,
						)
					: stripControls(stdout);
				mkdirSync(dirname(cachePath), { recursive: true });
				writeFileSync(cachePath, `${content}\n`);
				resolve(content.split("\n"));
			},
		);
	});
}

function projectName(ctx: ExtensionContext): string {
	return ctx.cwd.split("/").filter(Boolean).at(-1) ?? "session";
}

function compose(
	width: number,
	ctx: ExtensionContext,
	image: string[],
): string[] {
	const model = (ctx as any).model?.id ?? "model";
	return [
		"",
		`${BOLD}${gradient(center("✦ welcome back, lukas ✦", width), 0.08)}${RESET}`,
		center(
			`${fg([161, 161, 170], projectName(ctx))} ${fg([113, 113, 122], "·")} ${fg([125, 211, 252], model)}`,
			width,
		),
		"",
		...image.map((line) => center(line, width)),
		"",
	];
}

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let cachedImage: string[] = [];
	let currentCtx: ExtensionContext | undefined;

	function install(ctx: ExtensionContext): void {
		currentCtx = ctx;
		if (!enabled || !ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_ID, undefined);
		ctx.ui.setHeader(() => ({
			invalidate() {},
			render(width: number): string[] {
				return compose(width, ctx, cachedImage).map((line) =>
					truncateToWidth(line, width),
				);
			},
		}));
	}

	async function show(ctx: ExtensionContext, force = false): Promise<void> {
		cachedImage = await renderImage(force);
		install(ctx);
	}

	function clear(ctx: ExtensionContext): void {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		ctx.ui.setHeader(undefined);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) await show(ctx);
	});
	pi.on("model_select", async () => {
		if (currentCtx) install(currentCtx);
	});
	pi.on("session_shutdown", async (_event, ctx) => clear(ctx));

	pi.registerCommand("landing", {
		description: "Show, hide, or regenerate the waifu startup header",
		handler: async (args, ctx) => {
			const action = String(args ?? "show")
				.trim()
				.toLowerCase();
			if (action === "hide" || action === "off" || action === "clear") {
				enabled = false;
				clear(ctx);
				return;
			}
			enabled = true;
			await show(ctx, action === "regen" || action === "refresh");
		},
	});
}
