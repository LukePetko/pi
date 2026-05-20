// @ts-nocheck
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type SubagentTmuxConfig = {
	windowIndex: number;
	windowName: string;
	closeWhenEmpty: boolean;
};

export type RunningSubagentPane = {
	runId: string;
	agent: string;
	index: number;
	status: string;
	outputPath?: string;
	asyncDir: string;
	cwd?: string;
	currentTool?: string;
	intercomTarget?: string;
};

export function envConfig(): SubagentTmuxConfig & {
	auto: boolean;
	refreshMs: number;
} {
	return {
		windowIndex: Number(process.env.PI_SUBAGENT_TMUX_WINDOW_INDEX || "9"),
		windowName: process.env.PI_SUBAGENT_TMUX_WINDOW_NAME || "subagents",
		auto: process.env.PI_SUBAGENT_TMUX_AUTO === "1",
		closeWhenEmpty: process.env.PI_SUBAGENT_TMUX_CLOSE_WHEN_EMPTY === "1",
		refreshMs: Math.max(
			500,
			Number(process.env.PI_SUBAGENT_TMUX_REFRESH_MS || "1500"),
		),
	};
}

export function inTmux() {
	return Boolean(process.env.TMUX || process.env.TMUX_PANE);
}

function tmux(args: string[]): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile("tmux", args, { encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(new Error(stderr.trim() || error.message));
			else resolvePromise(stdout.trim());
		});
	});
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function currentSession() {
	return tmux(["display-message", "-p", "#{session_name}"]);
}

type TmuxWindow = { index: number; id: string; name: string };

async function windowsInSession(session: string): Promise<TmuxWindow[]> {
	const out = await tmux([
		"list-windows",
		"-t",
		session,
		"-F",
		"#{window_index}\t#{window_id}\t#{window_name}",
	]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [index, id, ...nameParts] = line.split("\t");
			return { index: Number(index), id, name: nameParts.join("\t") };
		});
}

async function windowAtIndex(session: string, index: number) {
	return (await windowsInSession(session)).find(
		(window) => window.index === index,
	);
}

export async function focusSubagentWindow(config = envConfig()) {
	if (!inTmux()) throw new Error("Not inside tmux");
	const session = await currentSession();
	const window = await windowAtIndex(session, config.windowIndex);
	if (!window) throw new Error(`No tmux window at index ${config.windowIndex}`);
	await tmux(["select-window", "-t", window.id]);
}

export async function closeSubagentWindow(config = envConfig()) {
	if (!inTmux()) throw new Error("Not inside tmux");
	const session = await currentSession();
	const window = await windowAtIndex(session, config.windowIndex);
	if (!window) return false;
	if (window.name !== config.windowName)
		throw new Error(
			`Refusing to kill non-${config.windowName} window at ${config.windowIndex}: ${window.name}`,
		);
	await tmux(["kill-window", "-t", window.id]);
	return true;
}

async function ensureWindow(config: SubagentTmuxConfig) {
	const session = await currentSession();
	const existing = await windowAtIndex(session, config.windowIndex);
	if (existing) {
		if (existing.name !== config.windowName)
			throw new Error(
				`Window ${config.windowIndex} is occupied by '${existing.name}', refusing to reuse it`,
			);
		await tmux(["rename-window", "-t", existing.id, config.windowName]);
		return existing.id;
	}

	const id = await tmux([
		"new-window",
		"-d",
		"-P",
		"-F",
		"#{window_id}",
		"-t",
		`${session}:`,
		"-n",
		config.windowName,
	]);
	await tmux([
		"move-window",
		"-s",
		id,
		"-t",
		`${session}:${config.windowIndex}`,
	]);
	await tmux(["rename-window", "-t", id, config.windowName]);
	return id;
}

async function paneIds(target: string) {
	const out = await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"]);
	return out ? out.split("\n").filter(Boolean) : [];
}

async function rebuildPaneCount(target: string, count: number) {
	let panes = await paneIds(target);
	for (const pane of panes.slice(1)) await tmux(["kill-pane", "-t", pane]);
	panes = await paneIds(target);
	while (panes.length < count) {
		await tmux(["split-window", "-d", "-t", target]);
		await tmux(["select-layout", "-t", target, "tiled"]).catch(() => undefined);
		panes = await paneIds(target);
	}
	return panes.slice(0, count);
}

function tempScopeIds() {
	const ids = new Set<string>();
	if (typeof process.getuid === "function") ids.add(String(process.getuid()));
	ids.add("unknown");
	return [...ids];
}

function readJson(path: string): any | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function asyncRoots() {
	return tempScopeIds().map((id) =>
		join(tmpdir(), `pi-subagents-uid-${id}`, "async-subagent-runs"),
	);
}

function chooseOutput(
	asyncDir: string,
	runId: string,
	index: number,
	step: any,
	status: any,
) {
	const outputFile = step?.outputFile || status?.outputFile;
	const candidates = [
		join(asyncDir, `output-${index}.log`),
		outputFile ? resolve(asyncDir, outputFile) : undefined,
		join(asyncDir, `subagent-log-${runId}.md`),
		join(asyncDir, "events.jsonl"),
	].filter(Boolean) as string[];
	return candidates.find((candidate) => existsSync(candidate));
}

export function discoverRunningSubagents(): RunningSubagentPane[] {
	const panes: RunningSubagentPane[] = [];
	for (const root of asyncRoots()) {
		if (!existsSync(root)) continue;
		for (const runId of readdirSync(root)) {
			const asyncDir = join(root, runId);
			const status = readJson(join(asyncDir, "status.json"));
			if (!status || !["queued", "running"].includes(status.state)) continue;
			const steps =
				Array.isArray(status.steps) && status.steps.length
					? status.steps
					: [{ agent: status.agent || "subagent", status: status.state }];
			steps.forEach((step: any, index: number) => {
				const state = step.status || step.state || status.state;
				if (!["queued", "running"].includes(state)) return;
				panes.push({
					runId,
					agent: step.agent || step.name || status.agent || "subagent",
					index,
					status: state,
					outputPath: chooseOutput(asyncDir, runId, index, step, status),
					asyncDir,
					cwd: step.cwd || status.cwd,
					currentTool: step.currentTool || step.tool,
					intercomTarget: step.intercomTarget || step.intercom?.target,
				});
			});
		}
	}
	return panes.sort((a, b) =>
		`${a.runId}:${a.index}`.localeCompare(`${b.runId}:${b.index}`),
	);
}

function paneCommand(pane: RunningSubagentPane) {
	const statusPath = join(pane.asyncDir, "status.json");
	const script = `
const fs = require('fs');
const statusPath = ${JSON.stringify(statusPath)};
const runId = ${JSON.stringify(pane.runId)};
const agent = ${JSON.stringify(pane.agent)};
const outputPath = ${JSON.stringify(pane.outputPath || "")};
function relTime(ms) { return ms ? Math.max(0, Math.round((Date.now() - ms) / 1000)) + 's ago' : 'n/a'; }
function draw() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch {}
  const step = Array.isArray(s.steps) ? (s.steps[${pane.index}] || s.steps[0] || {}) : {};
  console.clear();
  console.log('subagent ' + (step.agent || agent) + '  run=' + runId + '  status=' + (step.status || s.state || ${JSON.stringify(pane.status)}));
  if (s.cwd || ${JSON.stringify(pane.cwd || "")}) console.log('cwd: ' + (s.cwd || ${JSON.stringify(pane.cwd || "")}));
  if (outputPath) console.log('log: ' + outputPath);
  console.log('last activity: ' + relTime(step.lastActivityAt || s.lastActivityAt));
  const t = step.tokens || s.totalTokens;
  if (t) console.log('tokens: ' + [t.input && ('in ' + t.input), t.output && ('out ' + t.output), t.total && ('total ' + t.total)].filter(Boolean).join(', '));
  if (step.toolCount || s.toolCount) console.log('tools: ' + (step.toolCount || s.toolCount));
  console.log('────────────────────────────────────────');
  const tools = Array.isArray(step.recentTools) ? step.recentTools.slice(-8) : [];
  if (tools.length) {
    console.log('recent tools:');
    for (const tool of tools) console.log('  - ' + tool.tool + (tool.args ? ': ' + String(tool.args).slice(0, 90) : ''));
  } else {
    console.log('waiting for activity...');
  }
  if (s.state && !['queued', 'running'].includes(s.state)) {
    console.log('────────────────────────────────────────');
    console.log('completed. Open the output artifact/result in Pi for the final summary.');
    process.exit(0);
  }
}
draw(); setInterval(draw, 2000);
`;
	return `node -e ${shellQuote(script)}`;
}

export async function renderSubagentPanes(
	panes: RunningSubagentPane[],
	config = envConfig(),
) {
	if (!inTmux())
		throw new Error(
			"Not inside tmux; start Pi from tmux to use subagent panes",
		);
	if (panes.length === 0 && config.closeWhenEmpty) {
		await closeSubagentWindow(config).catch(() => false);
		return "No running subagents; closed window";
	}
	const target = await ensureWindow(config);
	const paneTargets = await rebuildPaneCount(target, Math.max(1, panes.length));
	if (panes.length === 0) {
		await tmux(["send-keys", "-t", paneTargets[0], "C-c"]);
		await tmux([
			"send-keys",
			"-t",
			paneTargets[0],
			"clear; echo 'No running subagents'; read -r _",
			"Enter",
		]);
		return "No running subagents";
	}
	for (const [i, pane] of panes.entries()) {
		const targetPane = paneTargets[i];
		await tmux([
			"select-pane",
			"-t",
			targetPane,
			"-T",
			`${pane.agent}:${pane.index}`,
		]).catch(() => undefined);
		await tmux(["send-keys", "-t", targetPane, "C-c"]);
		await tmux(["send-keys", "-t", targetPane, paneCommand(pane), "Enter"]);
	}
	await tmux(["select-layout", "-t", target, "tiled"]).catch(() => undefined);
	return `Showing ${panes.length} running subagent pane(s) in ${config.windowIndex}:${config.windowName}`;
}

export function descriptorHash(panes: RunningSubagentPane[]) {
	return JSON.stringify(
		panes.map((p) => [
			p.runId,
			p.agent,
			p.index,
			p.status,
			p.outputPath,
			p.intercomTarget,
		]),
	);
}
