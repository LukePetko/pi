import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { hubStateDir } from "./pi-hub-web-launcher.ts";

export type PermissionDecision = "once" | "reject";
export type LocalPermissionDecision = PermissionDecision | "always";
export interface PermissionSummary { id: string; title: string }
export interface PermissionRequest extends PermissionSummary {
	createdAt: number;
	cwd: string;
	description: string;
	toolName?: string;
	input?: string;
}
export interface PermissionIdentity { id: string; pid: number; startedAt?: number }
interface Manifest {
	version: 1;
	id: string;
	pid: number;
	updatedAt: number;
	origin: string;
	token: string;
	pending: PermissionSummary[];
}
export interface PermissionAction { id: string; requestId: string; decision?: PermissionDecision }
export interface PermissionTicket {
	id: string;
	ready: Promise<void>;
	decide(decision: LocalPermissionDecision): void;
	cancel(): void;
}
export const permissionDirectory = () => join(hubStateDir(), "permissions");
const MAX_REQUEST_BYTES = 1024 * 1024;

function manifestPath(directory: string, identity: PermissionIdentity): string {
	const key = createHash("sha256").update(JSON.stringify([identity.id, identity.pid])).digest("hex");
	return join(directory, `${key}.json`);
}

export async function readPermissionAction(req: IncomingMessage): Promise<PermissionAction> {
	let body = "";
	for await (const chunk of req) {
		body += chunk.toString();
		if (Buffer.byteLength(body) > 2048) throw new Error("Request too large");
	}
	try {
		const value = JSON.parse(body);
		if (!value || typeof value.id !== "string" || !value.id || value.id.length > 256
			|| typeof value.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(value.requestId)
			|| (value.decision !== undefined && value.decision !== "once" && value.decision !== "reject")) {
			throw new Error("Invalid permission action");
		}
		return { id: value.id, requestId: value.requestId, decision: value.decision };
	} catch { throw new Error("Invalid permission action"); }
}

async function readManifest(directory: string, session: PermissionIdentity): Promise<Manifest | undefined> {
	try {
		const contents = await readFile(manifestPath(directory, session), "utf8");
		if (Buffer.byteLength(contents) > 32 * 1024) return undefined;
		const value = JSON.parse(contents);
		if (value?.version !== 1 || value.id !== session.id || value.pid !== session.pid
			|| !Number.isFinite(value.updatedAt) || value.updatedAt < (session.startedAt ?? 0) - 5000
			|| typeof value.origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.origin)
			|| typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)
			|| !Array.isArray(value.pending) || value.pending.length > 32
			|| !value.pending.every((item) => typeof item?.title === "string" && item.title.length <= 1024
				&& typeof item.id === "string" && /^[a-f0-9-]{36}$/.test(item.id))) return undefined;
		return value as Manifest;
	} catch { return undefined; }
}

/** Only non-sensitive summaries leave the private cache; endpoint tokens never reach Hub clients. */
export async function readPermissionSummaries(session: PermissionIdentity, directory = permissionDirectory()): Promise<PermissionSummary[]> {
	const manifest = await readManifest(directory, session);
	return manifest?.pending.map(({ id, title }) => ({ id, title })) ?? [];
}

export class PermissionUnavailable extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}

async function forwardPermission(session: PermissionIdentity, action: PermissionAction, route: string, directory: string) {
	const manifest = await readManifest(directory, session);
	if (!manifest?.pending.some((item) => item.id === action.requestId)) {
		throw new PermissionUnavailable(409, "Permission request is no longer pending.");
	}
	let response: Response;
	try {
		response = await fetch(`${manifest.origin}/${route}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${manifest.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(action), signal: AbortSignal.timeout(3000), redirect: "error",
		});
	} catch { throw new PermissionUnavailable(503, "Permission owner is unavailable. Use its terminal."); }
	if (!response.ok) {
		throw new PermissionUnavailable(response.status === 413 ? 413 : 409,
			response.status === 413 ? "Request is too large for web approval. Use its terminal." : "Permission request is no longer pending.");
	}
	return response.json();
}

export async function inspectPermission(session: PermissionIdentity, requestId: string, directory = permissionDirectory()): Promise<PermissionRequest> {
	const result = await forwardPermission(session, { id: session.id, requestId }, "inspect", directory);
	return result.permission as PermissionRequest;
}

export async function decidePermission(session: PermissionIdentity, requestId: string, decision: PermissionDecision, directory = permissionDirectory()): Promise<void> {
	await forwardPermission(session, { id: session.id, requestId, decision }, "decision", directory);
}

/** In-memory owner of live decisions. The HTTP bridge never grants persistent approvals. */
export async function createPermissionBroker(directory = permissionDirectory()) {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const token = randomBytes(32).toString("hex");
	const pending = new Map<string, { session: PermissionIdentity; request: PermissionRequest; done: (decision: LocalPermissionDecision) => void }>();
	const identities = new Map<string, PermissionIdentity>();
	let origin = "";
	let closed = false;
	let writes = Promise.resolve();

	function publish(session: PermissionIdentity): Promise<void> {
		writes = writes.catch(() => {}).then(async () => {
			const file = manifestPath(directory, session);
			const summaries = [...pending.values()].filter((entry) => entry.session.id === session.id && entry.session.pid === session.pid)
				.map(({ request }) => ({ id: request.id, title: request.title }));
			if (summaries.length === 0) {
				const previous = await readManifest(directory, session);
				if (previous?.token === token) await unlink(file).catch(() => {});
				return;
			}
			const temporary = `${file}.${randomUUID()}.tmp`;
			try {
				await writeFile(temporary, JSON.stringify({ version: 1, id: session.id, pid: session.pid,
					updatedAt: Date.now(), origin, token, pending: summaries }), { mode: 0o600, flag: "wx" });
				await rename(temporary, file);
			} finally { await unlink(temporary).catch(() => {}); }
		});
		return writes;
	}

	function settle(id: string, decision?: LocalPermissionDecision): Promise<void> {
		const entry = pending.get(id);
		if (!entry) return Promise.resolve();
		pending.delete(id); // Consume before callbacks: simultaneous terminal/browser decisions are once-only.
		try { if (decision) entry.done(decision); } catch { /* UI may already be disposed. */ }
		return publish(entry.session);
	}

	function reply(res: ServerResponse, status: number, body: { error: string } | { ok: true } | { permission: PermissionRequest }): void {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const expected = Buffer.from(`Bearer ${token}`);
		const actual = Buffer.from(req.headers.authorization ?? "");
		if (closed || req.headers.host !== origin.slice(7) || req.headers.origin
			|| actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
			reply(res, 403, { error: "Not authorized" }); return;
		}
		if (req.method !== "POST" || !["/inspect", "/decision"].includes(req.url ?? "")
			|| req.headers["content-type"] !== "application/json") {
			reply(res, 404, { error: "Not found" }); return;
		}
		let action: PermissionAction;
		try { action = await readPermissionAction(req); }
		catch { reply(res, 400, { error: "Invalid permission action" }); return; }
		const entry = pending.get(action.requestId);
		if (!entry || entry.session.id !== action.id) { reply(res, 409, { error: "Request expired" }); return; }
		if (Buffer.byteLength(JSON.stringify(entry.request)) > MAX_REQUEST_BYTES) {
			reply(res, 413, { error: "Use terminal approval for this request" }); return;
		}
		if (req.url === "/inspect") { reply(res, 200, { permission: entry.request }); return; }
		if (!action.decision) { reply(res, 400, { error: "Decision required" }); return; }
		await settle(action.requestId, action.decision).catch(() => {});
		reply(res, 200, { ok: true });
	}

	const server = createServer((req, res) => {
		void handle(req, res).catch(() => { if (res.headersSent) res.destroy(); else reply(res, 500, { error: "Permission bridge failed" }); });
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	server.maxHeadersCount = 20;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Permission bridge did not start");
	origin = `http://127.0.0.1:${address.port}`;

	return {
		directory,
		request(session: PermissionIdentity, details: Omit<PermissionRequest, "id" | "createdAt">, done: (decision: LocalPermissionDecision) => void): PermissionTicket {
			if (closed || pending.size >= 32) throw new Error("Permission bridge is unavailable");
			const id = randomUUID();
			pending.set(id, { session, request: { ...details, id, createdAt: Date.now() }, done });
			identities.set(manifestPath(directory, session), session);
			return { id, ready: publish(session), decide: (decision) => { void settle(id, decision).catch(() => {}); },
				cancel: () => { void settle(id).catch(() => {}); } };
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			for (const id of [...pending.keys()]) await settle(id, "reject").catch(() => {});
			for (const session of identities.values()) await publish(session).catch(() => {});
			await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
		},
	};
}
