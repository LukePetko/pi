import { timingSafeEqual } from "node:crypto";
import { loadHubBrowserAsset } from "./hub-browser-assets.ts";
import type { HubTodos } from "./hub-todos.ts";
import { inspectPermission, decidePermission, readPermissionAction, PermissionUnavailable,
	type PermissionSummary, type PermissionRequest } from "./hub-permissions.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SessionInfo } from "../../npm/node_modules/pi-intercom/types.ts";

export interface HubSession extends SessionInfo {
	todos?: HubTodos;
	permissions?: PermissionSummary[];
}

export interface HubSnapshot {
	connected: boolean;
	sessions: HubSession[];
}

export interface HubSource {
	snapshot(): HubSnapshot;
	subscribe(listener: () => void): () => void;
	resolveSession(id: string): Promise<SessionInfo | undefined>;
}

export interface HubServerOptions {
	token: string;
	source: HubSource;
	focus: (pid: number) => Promise<void>;
	onStop?: () => void;
	idleMs?: number;
	permissions?: { inspect: typeof inspectPermission; decide: typeof decidePermission };
}

const ASSETS = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.ts", "text/javascript; charset=utf-8"]],
	["/todos.js", ["todos.ts", "text/javascript; charset=utf-8"]],
	["/permissions.js", ["permissions.ts", "text/javascript; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);

function authorized(req: IncomingMessage, token: string): boolean {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(req.headers.authorization ?? "");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

type HubReply =
	| { permission: PermissionRequest } | { error: string } | { ok: true } | { service: "pi-hub-web"; version: 1; pid: number };

function reply(res: ServerResponse, status: number, body: HubReply): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readTarget(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += chunk.toString();
		if (Buffer.byteLength(body) > 1024) throw new Error("Request too large");
	}
	try {
		const data = JSON.parse(body);
		if (!data || typeof data.id !== "string" || !data.id || data.id.length > 256) {
			throw new Error("A session ID is required");
		}
		return data.id;
	} catch {
		throw new Error("Invalid session ID request");
	}
}

/** Loopback-only HTTP adapter. No agent messages, shell input, or arbitrary files. */
export async function startHubServer(options: HubServerOptions) {
	const { source, token } = options;
	const assets = new Map<string, { content: string; type: string }>();
	for (const [route, [file, type]] of ASSETS) {
		assets.set(route, {
			content: await loadHubBrowserAsset(file),
			type,
		});
	}
	const streams = new Set<ServerResponse>();
	let origin = "";
	let closing = false;
	let focusing = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	function armIdle(): void {
		clearTimeout(idleTimer);
		if (!closing && streams.size === 0) {
			idleTimer = setTimeout(() => void close(), options.idleMs ?? 5 * 60_000);
			idleTimer.unref();
		}
	}

	function sendSnapshot(res: ServerResponse): void {
		// A slow browser must not accumulate an unbounded event backlog.
		if (res.writableLength > 256 * 1024) {
			res.destroy();
			return;
		}
		res.write(`data: ${JSON.stringify(source.snapshot())}\n\n`);
	}

	async function focus(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers["content-type"] !== "application/json") {
			reply(res, 415, { error: "Expected application/json" });
			return;
		}
		if (focusing) {
			reply(res, 429, { error: "Another focus request is in progress" });
			return;
		}
		let id: string;
		try {
			id = await readTarget(req);
		} catch {
			reply(res, 400, { error: "Invalid session ID request" });
			return;
		}
		// Take the guard before awaiting the broker; serialize OS focus actions.
		if (focusing) {
			reply(res, 429, { error: "Another focus request is in progress" });
			return;
		}
		focusing = true;
		try {
			const session = await source.resolveSession(id);
			if (!session || !Number.isSafeInteger(session.pid) || session.pid <= 1) {
				reply(res, 404, { error: "Session is no longer available" });
				return;
			}
			await options.focus(session.pid);
			reply(res, 200, { ok: true });
		} catch {
			reply(res, 503, { error: "Could not focus this session. Is its terminal attached and AeroSpace running?" });
		} finally {
			focusing = false;
		}
	}

	async function permission(req: IncomingMessage, res: ServerResponse, decide: boolean): Promise<void> {
		if (req.headers["content-type"] !== "application/json") {
			reply(res, 415, { error: "Expected application/json" }); return;
		}
		let action: Awaited<ReturnType<typeof readPermissionAction>>;
		try {
			action = await readPermissionAction(req);
			if (decide !== (action.decision !== undefined)) throw new Error("Invalid decision");
		} catch { reply(res, 400, { error: "Invalid permission action" }); return; }
		try {
			const session = await source.resolveSession(action.id);
			if (!session || !Number.isSafeInteger(session.pid) || session.pid <= 1) {
				reply(res, 404, { error: "Session is no longer available" }); return;
			}
			const gateway = options.permissions ?? { inspect: inspectPermission, decide: decidePermission };
			if (decide) {
				await gateway.decide(session, action.requestId, action.decision!);
				reply(res, 200, { ok: true });
			} else {
				reply(res, 200, { permission: await gateway.inspect(session, action.requestId) });
			}
		} catch (error) {
			reply(res, error instanceof PermissionUnavailable ? error.status : 503,
				{ error: error instanceof PermissionUnavailable ? error.message : "Permission owner is unavailable. Use its terminal." });
		}
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
		// Host validation also rejects DNS rebinding; no CORS is enabled.
		if (req.headers.host !== origin.slice("http://".length) ||
			(req.headers.origin && req.headers.origin !== origin) ||
			req.headers["sec-fetch-site"] === "cross-site") {
			reply(res, 403, { error: "Origin not allowed" });
			return;
		}
		const route = req.url ?? "/";
		const asset = assets.get(route);
		if (req.method === "GET" && asset) {
			res.writeHead(200, { "Content-Type": asset.type });
			res.end(asset.content);
			return;
		}
		if (!authorized(req, token)) {
			reply(res, 401, { error: "Open this dashboard using /hub-web in Pi" });
			return;
		}
		if (req.method === "GET" && route === "/api/health") {
			armIdle();
			reply(res, 200, { service: "pi-hub-web", version: 1, pid: process.pid });
		} else if (req.method === "GET" && route === "/api/events") {
			if (streams.size >= 16) {
				reply(res, 429, { error: "Too many dashboard connections" });
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			streams.add(res);
			armIdle();
			res.on("close", () => { streams.delete(res); armIdle(); });
			sendSnapshot(res);
		} else if (req.method === "POST" && req.headers.origin === origin && route === "/api/focus") {
			await focus(req, res);
		} else if (req.method === "POST" && req.headers.origin === origin &&
			(route === "/api/permissions/inspect" || route === "/api/permissions/decision")) {
			await permission(req, res, route.endsWith("/decision"));
		} else if (req.method === "POST" && req.headers.origin === origin && route === "/api/stop") {
			reply(res, 200, { ok: true });
			void close();
		} else {
			reply(res, 404, { error: "Not found" });
		}
	}

	const server = createServer((req, res) => {
		void handle(req, res).catch(() => {
			if (res.headersSent) res.destroy(); else reply(res, 500, { error: "Hub request failed" });
		});
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxHeadersCount = 30;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No Hub TCP address");
	origin = `http://127.0.0.1:${address.port}`;
	const unsubscribe = source.subscribe(() => { for (const res of streams) sendSnapshot(res); });
	const heartbeat = setInterval(() => {
		for (const res of streams) {
			if (res.writableLength > 256 * 1024) res.destroy();
			else res.write(": heartbeat\n\n");
		}
	}, 15_000);
	heartbeat.unref();
	armIdle();

	async function close(): Promise<void> {
		if (closing) return;
		closing = true;
		clearTimeout(idleTimer);
		clearInterval(heartbeat);
		unsubscribe();
		for (const res of streams) res.end();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
		options.onStop?.();
	}

	return { origin, close };
}
