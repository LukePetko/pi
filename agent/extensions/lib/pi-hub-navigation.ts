import { execFileSync } from "node:child_process";

export type CommandRunner = (command: string, args: string[]) => string;

export type TmuxPane = {
	session: string;
	windowId: string;
	paneId: string;
	pid: number;
};

export type TmuxClient = {
	name: string;
	pid: number;
	session: string;
	activity: number;
};

export type AeroSpaceWindow = {
	id: string;
	workspace: string;
	appName: string;
};

export type PiNavigationTarget = {
	pane?: TmuxPane;
	client?: TmuxClient;
	window: AeroSpaceWindow;
};

function runCommand(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function parseProcessParents(output: string): Map<number, number> {
	const parents = new Map<number, number>();
	for (const line of output.split("\n")) {
		const [pidText, parentText] = line.trim().split(/\s+/, 2);
		const pid = Number(pidText);
		const parent = Number(parentText);
		if (Number.isInteger(pid) && Number.isInteger(parent))
			parents.set(pid, parent);
	}
	return parents;
}

function ancestorDistance(
	pid: number,
	ancestor: number,
	parents: Map<number, number>,
): number | undefined {
	let current = pid;
	const visited = new Set<number>();
	for (let distance = 0; current > 0 && !visited.has(current); distance += 1) {
		if (current === ancestor) return distance;
		visited.add(current);
		current = parents.get(current) ?? 0;
	}
	return undefined;
}

export function parseTmuxPanes(output: string): TmuxPane[] {
	return output
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const [session, windowId, paneId, pidText] = line.split("\t");
			const pid = Number(pidText);
			if (!session || !windowId || !paneId || !Number.isInteger(pid)) return [];
			return [{ session, windowId, paneId, pid }];
		});
}

export function findTmuxPaneForPid(
	pid: number,
	panes: TmuxPane[],
	parents: Map<number, number>,
): TmuxPane | undefined {
	return panes
		.map((pane) => ({
			pane,
			distance: ancestorDistance(pid, pane.pid, parents),
		}))
		.filter(
			(candidate): candidate is { pane: TmuxPane; distance: number } =>
				candidate.distance !== undefined,
		)
		.sort((left, right) => left.distance - right.distance)[0]?.pane;
}

export function parseTmuxClients(output: string): TmuxClient[] {
	return output
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const [name, pidText, session, activityText] = line.split("\t");
			const pid = Number(pidText);
			const activity = Number(activityText);
			if (!name || !session || !Number.isInteger(pid)) return [];
			return [
				{
					name,
					pid,
					session,
					activity: Number.isFinite(activity) ? activity : 0,
				},
			];
		});
}

function processChain(pid: number, parents: Map<number, number>): number[] {
	const chain: number[] = [];
	const visited = new Set<number>();
	let current = pid;
	while (current > 1 && !visited.has(current)) {
		chain.push(current);
		visited.add(current);
		current = parents.get(current) ?? 0;
	}
	return chain;
}

function parseAeroSpaceWindows(output: string): AeroSpaceWindow[] {
	return output
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const [id, workspace, ...appParts] = line.split("\t");
			if (!id) return [];
			return [{ id, workspace: workspace ?? "", appName: appParts.join("\t") }];
		});
}

function optionalRun(
	runner: CommandRunner,
	command: string,
	args: string[],
): string {
	try {
		return runner(command, args);
	} catch {
		return "";
	}
}

function findAeroSpaceWindow(
	pid: number,
	parents: Map<number, number>,
	runner: CommandRunner,
): AeroSpaceWindow | undefined {
	for (const candidatePid of processChain(pid, parents)) {
		const output = optionalRun(runner, "aerospace", [
			"list-windows",
			"--monitor",
			"all",
			"--pid",
			String(candidatePid),
			"--format",
			"%{window-id}\t%{workspace}\t%{app-name}",
		]);
		const window = parseAeroSpaceWindows(output)[0];
		if (window) return window;
	}
	return undefined;
}

export function resolvePiNavigationTarget(
	pid: number,
	runner: CommandRunner = runCommand,
): PiNavigationTarget {
	const parents = parseProcessParents(runner("ps", ["-axo", "pid=,ppid="]));
	const panes = parseTmuxPanes(
		optionalRun(runner, "tmux", [
			"list-panes",
			"-a",
			"-F",
			"#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}",
		]),
	);
	const pane = findTmuxPaneForPid(pid, panes, parents);
	let client: TmuxClient | undefined;
	let nativePid = pid;

	if (pane) {
		const clients = parseTmuxClients(
			optionalRun(runner, "tmux", [
				"list-clients",
				"-F",
				"#{client_name}\t#{client_pid}\t#{session_name}\t#{client_activity}",
			]),
		)
			.filter((candidate) => candidate.session === pane.session)
			.sort((left, right) => right.activity - left.activity);
		client = clients[0];
		if (!client)
			throw new Error(`tmux session ${pane.session} is not attached`);
		nativePid = client.pid;
	}

	const window = findAeroSpaceWindow(nativePid, parents, runner);
	if (!window) {
		throw new Error(
			pane
				? `Could not find the AeroSpace terminal window for tmux pane ${pane.paneId}`
				: `Could not find an AeroSpace window for Pi process ${pid}`,
		);
	}
	return { ...(pane ? { pane } : {}), ...(client ? { client } : {}), window };
}

export function focusPiSession(
	pid: number,
	runner: CommandRunner = runCommand,
): PiNavigationTarget {
	const target = resolvePiNavigationTarget(pid, runner);
	if (target.pane) {
		runner("tmux", ["select-window", "-t", target.pane.windowId]);
		runner("tmux", ["select-pane", "-t", target.pane.paneId]);
	}
	runner("aerospace", ["focus", "--window-id", target.window.id]);
	return target;
}
