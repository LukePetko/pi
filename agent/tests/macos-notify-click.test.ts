import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	ensureClickableNotifierApp,
	findNotifierApp,
	notificationFocusCommand,
} from "../extensions/lib/macos-notify-click.ts";

function fixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi notify's test-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const app = join(root, "Cellar", "terminal-notifier.app");
	mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
	mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
	writeFileSync(join(app, "Contents", "MacOS", "terminal-notifier"), "binary");
	writeFileSync(join(app, "Contents", "Resources", "MainMenu.nib"), "delegate");
	writeFileSync(join(app, "Contents", "Info.plist"), "original plist");
	const icon = join(root, "AppIcon.icns");
	writeFileSync(icon, "pi icon");
	return { root, app, icon, target: join(root, "cache", "Pi Notifier.app") };
}

test("locates the full app behind a Homebrew wrapper or direct binary", (t) => {
	const { root, app } = fixture(t);
	const brewBin = join(root, "Cellar", "bin");
	const bin = join(root, "bin");
	mkdirSync(brewBin);
	mkdirSync(bin);
	writeFileSync(join(brewBin, "terminal-notifier"), "#!/bin/sh\nexit 0\n");
	symlinkSync(join(brewBin, "terminal-notifier"), join(bin, "terminal-notifier"));
	assert.equal(findNotifierApp(`${root}/missing:${bin}`), app);
	assert.equal(findNotifierApp(join(app, "Contents", "MacOS")), app);
	assert.throws(() => findNotifierApp(join(root, "missing")), /Could not locate/);
});

test("copies activation resources, signs and registers the custom sender, without altering the source", (t) => {
	const { app, icon, target } = fixture(t);
	const calls = [];
	const runner = (command, args) => { calls.push([command, args]); return ""; };
	const options = { sourceApp: app, app: target, icon, bundleId: "test.pi" };
	const executable = ensureClickableNotifierApp(options, runner);
	assert.equal(executable, join(target, "Contents", "MacOS", "terminal-notifier"));
	assert.equal(readFileSync(join(target, "Contents", "Resources", "MainMenu.nib"), "utf8"), "delegate");
	assert.equal(readFileSync(join(target, "Contents", "Resources", "AppIcon.icns"), "utf8"), "pi icon");
	assert.equal(readFileSync(join(app, "Contents", "Info.plist"), "utf8"), "original plist");
	assert.deepEqual(calls.slice(0, 4).map(([, args]) => args[1]), [
		"Set :CFBundleIdentifier test.pi",
		"Set :CFBundleName Pi Notifier",
		"Set :CFBundleIconFile AppIcon",
		"Set :NSUserNotificationAlertStyle alert",
	]);
	assert.equal(calls[4][0], "/usr/bin/codesign");
	assert.deepEqual(calls.at(-1)[1], ["-f", target]);
	calls.length = 0;
	assert.equal(ensureClickableNotifierApp(options, runner), executable);
	assert.equal(calls.length, 1, "reuse the generated app but refresh its registration");
	assert.ok(calls[0][0].endsWith("/lsregister"));
});

test("failed signing leaves no partial app or staging directory", (t) => {
	const { root, app, icon, target } = fixture(t);
	assert.throws(() => ensureClickableNotifierApp({ sourceApp: app, app: target, icon, bundleId: "test.pi" }, (command) => {
		if (command === "/usr/bin/codesign") throw new Error("signing failed");
		return "";
	}), /signing failed/);
	assert.equal(existsSync(target), false);
	assert.deepEqual(readdirSync(join(root, "cache")), []);
});

function focusFixture(t) {
	const { root } = fixture(t);
	const bin = join(root, "commands");
	mkdirSync(bin);
	const log = join(root, "calls");
	const originalPath = process.env.PATH;
	const originalTmux = process.env.TMUX;
	t.after(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = originalTmux;
	});
	process.env.PATH = `${bin}:/usr/bin:/bin`;
	process.env.TMUX = "/tmp/pi socket's server,1,0";
	for (const [name, body] of [
		["ps", `printf '${process.pid} 100\\n100 1\\n2000 200\\n200 1\\n'`],
		["tmux", `case "$1" in\nlist-panes) printf 'pi\\t@3\\t%%7\\t100\\n';;\nlist-clients) printf '/dev/ttys001\\t2000\\tpi\\t20\\n';;\nesac`],
		["aerospace", `if [ "$1" = list-windows ]; then printf '123\\t1\\tGhostty\\n'; fi`],
	]) {
		writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s|%s|%s\\n' '${name}' "$*" "$TMUX" >> "$CLICK_TEST_LOG"\n${body}\n`, { mode: 0o755 });
	}
	const startedAt = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
	const invoke = (stamp) => execFileSync("/bin/sh", ["-c", notificationFocusCommand(process.pid, stamp)], {
		env: { ...process.env, PATH: "/usr/bin:/bin", TMUX: "wrong server", CLICK_TEST_LOG: log },
		stdio: "pipe",
	});
	return { log, startedAt, invoke };
}

test("a click resolves the originating live Pi through Hub and preserves PATH/TMUX across shell quoting", (t) => {
	const { log, startedAt, invoke } = focusFixture(t);
	invoke(startedAt);
	const calls = readFileSync(log, "utf8").trim().split("\n");
	assert.deepEqual(calls.slice(-3), [
		"tmux|select-window -t @3|/tmp/pi socket's server,1,0",
		"tmux|select-pane -t %7|/tmp/pi socket's server,1,0",
		"aerospace|focus --window-id 123|/tmp/pi socket's server,1,0",
	]);
});

test("stale notifications cannot focus a recycled process ID", (t) => {
	const { log, invoke } = focusFixture(t);
	invoke("different process start time");
	assert.equal(existsSync(log), false);
});

test("invalid process identities cannot generate a click command", () => {
	for (const pid of [0, -1, NaN, Infinity, 1.5]) {
		assert.throws(() => notificationFocusCommand(pid, "start"), /identity/);
	}
	assert.throws(() => notificationFocusCommand(process.pid, " "), /identity/);
});
