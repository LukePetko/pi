import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decidePermission } from "./hub-permissions.ts";
import { focusPiSession } from "./pi-hub-navigation.ts";
import type { PermissionNotice } from "./permission-notifications.ts";

export interface NativePermissionRecord {
	version: 1;
	title: string;
	body: string;
	actionable: boolean;
	callback: { executable: string; arguments: string[]; environment: Record<string, string> };
	target: { pid: number; startedAt: string };
	broker?: PermissionNotice["broker"];
}

export function processBirth(pid: number): string {
	return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
}

/** No shell execution and no persistent approval: the broker remains the decision authority. */
export async function performNativePermissionAction(
	record: NativePermissionRecord,
	action: string,
	dependencies = { birth: processBirth, focus: focusPiSession, decide: decidePermission },
): Promise<void> {
	if (!["accept", "reject", "show"].includes(action)) throw new Error("Unsupported permission action");
	if (record.version !== 1 || !Number.isSafeInteger(record.target?.pid) || record.target.pid <= 0
		|| !record.target.startedAt || dependencies.birth(record.target.pid) !== record.target.startedAt) {
		throw new Error("The requesting Pi process is no longer alive");
	}
	if (action === "show") { dependencies.focus(record.target.pid); return; }
	const broker = record.broker;
	if (!record.actionable || !broker || broker.session.pid !== record.target.pid
		|| typeof broker.session.id !== "string" || !broker.session.id
		|| typeof broker.requestId !== "string" || !broker.requestId
		|| typeof broker.directory !== "string" || !broker.directory) {
		throw new Error("This permission requires a decision in Pi or Hub");
	}
	await dependencies.decide(broker.session, broker.requestId, action === "accept" ? "once" : "reject", broker.directory);
}

async function main(): Promise<void> {
	try {
		const record = JSON.parse(await readFile(process.argv[2], "utf8")) as NativePermissionRecord;
		await performNativePermissionAction(record, process.argv[3]);
	} catch {
		// The native helper shows a retry/Show alert; never silently treat failure as approval.
		process.exitCode = 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) void main();
