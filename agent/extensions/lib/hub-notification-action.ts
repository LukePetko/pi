import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEndpoint } from "./pi-hub-web-launcher.ts";
import { NOTIFICATION_API } from "./hub-notification-protocol.ts";

/** Fixed native callback: only a per-alert capability, never the endpoint admin token. */
export async function performHubNotificationAction(path: string, action: string): Promise<void> {
	if (!["show", "accept", "reject", "dismiss"].includes(action)) throw new Error("Unsupported notification action");
	const data = await readFile(path, "utf8");
	if (Buffer.byteLength(data) > 16384) throw new Error("Invalid notification record");
	const record = JSON.parse(data);
	const endpoint = await readEndpoint(record.endpointFile);
	if (!endpoint) throw new Error("Notification service unavailable");
	const response = await fetch(`${endpoint.origin}${NOTIFICATION_API}action`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id: record.id, capability: record.capability, action }),
		signal: AbortSignal.timeout(8000), redirect: "error",
	});
	if (!response.ok) throw new Error("Native notification action unavailable; use Pi");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	void performHubNotificationAction(process.argv[2], process.argv[3]).catch(() => { process.exitCode = 1; });
}
