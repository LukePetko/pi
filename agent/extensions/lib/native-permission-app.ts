import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const source = fileURLToPath(new URL("./native-permissions/Notifier.swift", import.meta.url));
export const NATIVE_PERMISSION_BUNDLE = "works.earendil.pi-permissions.lukas";
export const nativePermissionRoot = () => join(homedir(), ".pi", "agent", "cache", "native-permissions");

export interface NativePermissionApp {
	executable: string;
	records: string;
}

const builds = new Map<string, Promise<NativePermissionApp>>();

/** Builds are content-addressed; no downloaded or generated binaries enter Git. */
export async function ensureNativePermissionApp(
	root = nativePermissionRoot(),
	icon = join(homedir(), ".pi", "agent", "Pi Notifier.app", "Contents", "Resources", "AppIcon.icns"),
): Promise<NativePermissionApp> {
	const fingerprint = createHash("sha256")
		.update(await readFile(source)).update(await readFile(icon)).update("pi-permissions-bundle-v1")
		.digest("hex").slice(0, 20);
	const directory = join(root, fingerprint);
	let build = builds.get(directory);
	if (!build) {
		build = buildApp(root, directory, icon);
		builds.set(directory, build);
		void build.catch(() => { if (builds.get(directory) === build) builds.delete(directory); });
	}
	return build;
}

async function buildApp(root: string, directory: string, icon: string): Promise<NativePermissionApp> {
	const app = join(directory, "Pi Permissions.app");
	const executable = join(app, "Contents", "MacOS", "Pi Permissions");
	const records = join(root, "requests");
	await mkdir(records, { recursive: true, mode: 0o700 });
	if (!(await stat(executable).catch(() => undefined))) {
		await mkdir(directory, { recursive: true });
		const temporary = await mkdtemp(join(directory, "build-"));
		const staged = join(temporary, "Pi Permissions.app");
		try {
			await mkdir(join(staged, "Contents", "MacOS"), { recursive: true });
			await mkdir(join(staged, "Contents", "Resources"));
			await cp(icon, join(staged, "Contents", "Resources", "AppIcon.icns"));
			await writeFile(join(staged, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Pi Permissions</string>
<key>CFBundleIdentifier</key><string>${NATIVE_PERMISSION_BUNDLE}</string>
<key>CFBundleName</key><string>Pi Permissions</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSUIElement</key><true/>
<key>NSUserNotificationAlertStyle</key><string>alert</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>\n`);
			await exec("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-O", source, "-o", join(staged, "Contents", "MacOS", "Pi Permissions")], { timeout: 120_000 });
			await exec("/usr/bin/codesign", ["--force", "--sign", "-", staged], { timeout: 30_000 });
			try { await rename(staged, app); }
			catch (error) { if (!(await stat(executable).catch(() => undefined))) throw error; }
		} finally { await rm(temporary, { recursive: true, force: true }); }
	}
	await exec("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app], { timeout: 10_000 });
	return { executable, records };
}

export function runNativePermissionApp(app: NativePermissionApp, operation: string, id?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(app.executable, [operation, ...(id ? [id] : [])], {
			timeout: operation === "show" || operation === "authorize" ? 120_000 : 10_000,
		}, (error, stdout) => error ? reject(error) : resolve(stdout));
		child.stdin?.end();
	});
}
