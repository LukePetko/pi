#!/usr/bin/env -S node --experimental-strip-types
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hubStatus, startHubWeb, stopHubWeb } from "./extensions/lib/pi-hub-web-launcher.ts";

const execute = promisify(execFile);
export async function runHubCommand(args: string[], options: {
	stateDir?: string;
	open?: (url: string) => Promise<void>;
} = {}): Promise<string> {
	if (args.length !== 1 || !["start", "stop", "status", "open"].includes(args[0])) {
		throw new Error("Usage: agent/hub.ts start|stop|status|open (PI_CODING_AGENT_DIR and PI_INTERCOM_SCOPE_ID select scope)");
	}
	if (args[0] === "status") return JSON.stringify(await hubStatus(options.stateDir));
	if (args[0] === "stop") {
		await stopHubWeb(options.stateDir);
		return "Hub stopped; automatic startup disabled until explicit start/open.";
	}
	const endpoint = await startHubWeb(options.stateDir);
	if (args[0] === "open") {
		const open = options.open ?? (async (url: string) => {
			await execute(process.platform === "darwin" ? "/usr/bin/open" : "xdg-open", [url], { timeout: 5_000 });
		});
		await open(`${endpoint.origin}/#${endpoint.token}`);
	}
	return `Hub ${args[0] === "open" ? "opened" : "running"} at ${endpoint.origin}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void runHubCommand(process.argv.slice(2)).then((message) => process.stdout.write(`${message}\n`)).catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : "Hub command failed"}\n`);
		process.exitCode = 1;
	});
}
