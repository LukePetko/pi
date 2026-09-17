import { execFile } from "node:child_process";
import { findTmuxPaneForPid, parseProcessParents, parseTmuxPanes } from "./pi-hub-navigation.ts";

export type FocusCommandRunner = (command: string, args: string[]) => Promise<string>;

function run(command: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(command, args, { timeout: 1500, maxBuffer: 1024 * 1024 },
			(error, stdout) => error ? reject(error) : resolve(stdout));
		child.stdin?.end();
	});
}

function owningWindow(pid: number, parents: Map<number, number>, windows: Map<number, string[]>): string | undefined {
	const visited = new Set<number>();
	while (pid > 1 && !visited.has(pid)) {
		visited.add(pid);
		const owned = windows.get(pid);
		// Never guess which of several windows belonging to one process is the Pi window.
		if (owned) return owned.length === 1 ? owned[0] : undefined;
		pid = parents.get(pid) ?? 0;
	}
	return undefined;
}

/** A focused terminal application alone is insufficient: require its selected tmux pane too. */
export async function isPiSessionFocused(pid: number, runner: FocusCommandRunner = run): Promise<boolean> {
	try {
		const [processes, paneOutput, windowOutput] = await Promise.all([
			runner("ps", ["-axo", "pid=,ppid="]),
			runner("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}"]),
			runner("aerospace", ["list-windows", "--monitor", "all", "--format", "%{window-id}\t%{app-pid}"]),
		]);
		const parents = parseProcessParents(processes);
		const pane = findTmuxPaneForPid(pid, parseTmuxPanes(paneOutput), parents);
		if (!pane) return false;
		const windows = new Map<number, string[]>();
		for (const line of windowOutput.trim().split("\n")) {
			const [id, owner] = line.split("\t");
			const ownerPid = Number(owner);
			if (id && Number.isSafeInteger(ownerPid) && ownerPid > 1) {
				windows.set(ownerPid, [...(windows.get(ownerPid) ?? []), id]);
			}
		}
		// Read active selection last, after resolving the stable process/window mapping.
		const [focused, clientOutput] = await Promise.all([
			runner("aerospace", ["list-windows", "--focused", "--format", "%{window-id}"]),
			runner("tmux", ["list-clients", "-F", "#{client_pid}\t#{pane_id}"]),
		]);
		const focusedId = focused.trim();
		if (!focusedId) return false;
		const matchingClients = clientOutput.trim().split("\n").flatMap(line => {
			const [clientPid, activePane] = line.split("\t");
			return activePane && owningWindow(Number(clientPid), parents, windows) === focusedId ? [activePane] : [];
		});
		// Multiple clients sharing one native window can represent hidden terminal tabs.
		return matchingClients.length === 1 && matchingClients[0] === pane.paneId;
	} catch {
		// Missing tmux/AeroSpace, unsupported layouts or query failures must preserve alerts.
		return false;
	}
}
