import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { hubStateDir } from "./pi-hub-web-launcher.ts";
import { attentionFields, lifecycleStatus, openAcknowledgements, type AttentionFields, type AttentionPermission } from "./hub-attention.ts";
export { classify } from "./hub-attention.ts";
import { loadHubBrowserAsset } from "./hub-browser-assets.ts";
import type { HubTodos } from "./hub-todos.ts";
import { inspectPermission, decidePermission, describePermission, readPermissionAction, PermissionUnavailable,
	type PermissionRequest } from "./hub-permissions.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SessionInfo } from "../../npm/node_modules/pi-intercom/types.ts";
import type { LifecycleFields } from "./hub-lifecycle.ts";

export interface HubSession extends SessionInfo, Partial<AttentionFields>, Partial<LifecycleFields> {
	todos?: HubTodos;
	permissions?: AttentionPermission[];
}

export interface HubSnapshot {
	connected: boolean;
	sessions: HubSession[];
}

export interface HubSource {
	snapshot(): HubSnapshot;
	subscribe(listener: () => void): () => void;
	resolveSession(id: string): Promise<HubSession | undefined>;
}

export interface HubServerOptions {
	/** Embedded/test servers default to an ephemeral port; the resident entry point selects its fixed port. */
	port?: number;
	notifications?: {
		register(value: unknown): Promise<unknown>;
		event(value: unknown): Promise<unknown>;
		action(value: unknown): Promise<unknown>;
		close(): Promise<void>;
	};
	token: string;
	source: HubSource;
	focus: (pid: number) => Promise<void>;
	onStop?: () => void;
	requestStop?: (close: () => Promise<void>, fence?: { revision: string; instance: string }) => Promise<boolean>;
	instance?: string;
	capabilities?: string[];
	lifetime?: "resident" | "browser-idle";
	idleMs?: number;
	stateFile?: string;
	permissions?: { inspect: typeof inspectPermission; decide: typeof decidePermission };
}

const ASSETS = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.ts", "text/javascript; charset=utf-8"]],
	["/board.js", ["board.ts", "text/javascript; charset=utf-8"]],
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
	| { permission: PermissionRequest } | { error: string } | { ok: true; snapshot?: HubSnapshot } | { service: "pi-hub-web"; version: 1; pid: number; instance?: string; mode: string; capabilities?: string[]; connected: boolean };

function reply(res: ServerResponse, status: number, body: HubReply): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readTarget(req: IncomingMessage): Promise<{ id: string; lastAgentEnd?: number; lifecycleGeneration?: string }> {
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
		if (data.lastAgentEnd !== undefined && (!Number.isFinite(data.lastAgentEnd) || data.lastAgentEnd < 0)) throw new Error("Invalid completion stamp");
		if (data.lifecycleGeneration !== undefined &&
			(typeof data.lifecycleGeneration !== "string" || data.lifecycleGeneration.length > 64))
			throw new Error("Invalid lifecycle generation");
		return { id: data.id, lastAgentEnd: data.lastAgentEnd, lifecycleGeneration: data.lifecycleGeneration };
	} catch {
		throw new Error("Invalid session ID request");
	}
}

/** Loopback-only HTTP adapter. No agent messages, shell input, or arbitrary files. */
export async function startHubServer(options: HubServerOptions) {
	const { source, token } = options;
	const acknowledgements = await openAcknowledgements(options.stateFile ?? join(hubStateDir(), "session.json"));
	const gateway = options.permissions ?? { inspect: inspectPermission, decide: decidePermission };
	const presentations = new Map<string, ReturnType<typeof describePermission> | null>();
	const settled = new Set<string>();
	const inspections: { key: string; session: HubSession; requestId: string }[] = [];
	let inspecting = 0;
	const permissionKey = (session: HubSession, requestId: string) => JSON.stringify([session.id, session.pid, session.startedAt, requestId]);
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
		if (options.lifetime === "browser-idle" && !closing && streams.size === 0) {
			idleTimer = setTimeout(() => void close(), options.idleMs ?? 5 * 60_000);
			idleTimer.unref();
		}
	}

	function snapshot(replacement?: HubSession): HubSnapshot {
		const state = source.snapshot();
		return { ...state, sessions: state.sessions.map(original => {
			const session = replacement?.id === original.id && replacement.pid === original.pid && replacement.startedAt === original.startedAt
				&& replacement.endpointEpoch === original.endpointEpoch
				// Presence timestamps cannot order producer lifecycle changes.
				&& original.turnState === undefined && replacement.turnState === undefined
				&& (!Number.isFinite(original.lastActivity) || replacement.lastActivity > original.lastActivity)
				? { ...original, ...replacement } : original;
			const permissions = (session.permissions ?? []).filter(item => !settled.has(permissionKey(session, item.id)))
				.map(item => ({ ...item, ...presentations.get(permissionKey(session, item.id)) }));
			const enriched = { ...session, permissions };
			return { ...enriched, ...attentionFields(enriched, acknowledgements.get()) };
		}) };
	}

	function broadcast(value = snapshot()): void {
		if (!closing) for (const response of streams) sendSnapshot(response, value);
	}

	function inspectNext(): void {
		while (!closing && inspecting < 4 && inspections.length) {
			const item = inspections.shift()!;
			if (!presentations.has(item.key)) continue;
			inspecting++;
			void Promise.resolve().then(() => gateway.inspect(item.session, item.requestId)).then(full => describePermission(full))
				.catch(() => ({ risk: "high" as const, tool: "unknown", summary: "Request details unavailable; use the terminal." }))
				.then(value => { if (presentations.has(item.key)) presentations.set(item.key, value); })
				.finally(() => { inspecting--; broadcast(); inspectNext(); });
		}
	}

	function refresh(): void {
		const state = source.snapshot();
		const wanted = new Set<string>();
		for (const session of state.connected ? state.sessions : []) for (const permission of session.permissions ?? []) {
			const key = permissionKey(session, permission.id);
			wanted.add(key);
			if (!presentations.has(key)) {
				presentations.set(key, null);
				inspections.push({ key, session, requestId: permission.id });
			}
		}
		for (const key of presentations.keys()) if (!wanted.has(key)) presentations.delete(key);
		for (const key of settled) if (!wanted.has(key)) settled.delete(key);
		broadcast();
		inspectNext();
	}

	async function acknowledge(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers["content-type"] !== "application/json") { reply(res, 415, { error: "Expected application/json" }); return; }
		let target: Awaited<ReturnType<typeof readTarget>>;
		try { target = await readTarget(req); }
		catch { reply(res, 400, { error: "Invalid acknowledgement" }); return; }
		try {
			const fresh = await source.resolveSession(target.id);
			const current = snapshot().sessions.find(session => session.id === target.id);
			if (!fresh || !current) { reply(res, 404, { error: "Session is no longer available" }); return; }
			const real = fresh.turnState !== undefined;
			const at = real ? fresh.lastAgentEnd : fresh.lastActivity;
			if (!source.snapshot().connected || fresh.pid !== current.pid || fresh.startedAt !== current.startedAt
				|| fresh.endpointEpoch !== current.endpointEpoch || fresh.lifecycleGeneration !== current.lifecycleGeneration
				|| (target.lifecycleGeneration !== undefined && target.lifecycleGeneration !== fresh.lifecycleGeneration)
				|| (real ? fresh.turnState !== "returned" || current.turnState !== "returned" || current.lastAgentEnd !== at
					: current.turnState !== undefined || lifecycleStatus(fresh.status) !== "idle" || lifecycleStatus(current.status) !== "idle")
				|| current.lastActivity > fresh.lastActivity || current.permissions?.length
				|| at == null || !Number.isFinite(at) || at < 0
				|| (target.lastAgentEnd !== undefined && target.lastAgentEnd !== at)) {
				reply(res, 409, { error: "Session changed or is still working/waiting for permission. Refresh before accepting." }); return;
			}
			await acknowledgements.set(fresh.id, at);
			const value = snapshot(fresh);
			reply(res, 200, { ok: true, snapshot: value });
			broadcast(value);
		} catch { reply(res, 503, { error: "Could not persist acknowledgement" }); }
	}

	function sendSnapshot(res: ServerResponse, value = snapshot()): void {
		// A slow browser must not accumulate an unbounded event backlog.
		if (res.writableLength > 256 * 1024) {
			res.destroy();
			return;
		}
		res.write(`data: ${JSON.stringify(value)}\n\n`);
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
			id = (await readTarget(req)).id;
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
			if (decide) {
				await gateway.decide(session, action.requestId, action.decision!);
				settled.add(permissionKey(session, action.requestId));
				const value = snapshot(session);
				reply(res, 200, { ok: true, snapshot: value });
				broadcast(value);
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
		if (closing) {
			reply(res, 503, { error: "Hub is stopping" });
			return;
		}
		const route = req.url ?? "/";
		const asset = assets.get(route);
		if (req.method === "GET" && asset) {
			res.writeHead(200, { "Content-Type": asset.type });
			res.end(asset.content);
			return;
		}
		if (route.startsWith("/api/v1/notifications/")) {
			// Producer/native routes are not browser APIs, even for same-origin pages.
			if (req.headers.origin || req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "none") {
				reply(res, 403, { error: "Local notification clients only" }); return;
			}
			const operation = route.slice("/api/v1/notifications/".length);
			if (!options.notifications || req.method !== "POST" || !["register", "event", "action"].includes(operation) || req.headers["content-type"] !== "application/json") {
				reply(res, 404, { error: "Notification API unavailable" }); return;
			}
			if (operation !== "action" && !authorized(req, token)) {
				reply(res, 401, { error: "Notification credential required" }); return;
			}
			try {
				let body = "";
				for await (const chunk of req) {
					body += chunk.toString();
					if (Buffer.byteLength(body) > 8192) {
						reply(res, 413, { error: "Notification request too large" }); return;
					}
				}
				const value = JSON.parse(body);
				const result = await options.notifications[operation as "register" | "event" | "action"](value);
				res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
			} catch (error: any) { reply(res, error.status ?? 400, { error: error.status ? error.message : "Invalid notification request" }); }
			return;
		}
		if (!authorized(req, token)) {
			reply(res, 401, { error: "Open this dashboard using /hub-web in Pi" });
			return;
		}
		if (req.method === "GET" && route === "/api/health") {
			armIdle();
			reply(res, 200, { service: "pi-hub-web", version: 1, pid: process.pid,
				instance: options.instance, mode: options.lifetime ?? "resident", capabilities: options.capabilities,
				connected: source.snapshot().connected });
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
		} else if (req.method === "POST" && req.headers.origin === origin && route === "/api/ack") {
			await acknowledge(req, res);
		} else if (req.method === "POST" && req.headers.origin === origin && route === "/api/focus") {
			await focus(req, res);
		} else if (req.method === "POST" && req.headers.origin === origin &&
			(route === "/api/permissions/inspect" || route === "/api/permissions/decision")) {
			await permission(req, res, route.endsWith("/decision"));
		} else if (req.method === "POST" && req.headers.origin === origin && route === "/api/stop") {
			const shutdown = async () => {
				reply(res, 200, { ok: true });
				await close();
			};
			const revision = req.headers["x-pi-hub-control-revision"];
			const instance = req.headers["x-pi-hub-instance"];
			let fence: { revision: string; instance: string } | undefined;
			if (revision !== undefined || instance !== undefined) {
				if (typeof revision !== "string" || typeof instance !== "string" ||
					!/^[a-f0-9-]{36}$/.test(revision) || !/^[a-f0-9-]{36}$/.test(instance)) {
					reply(res, 400, { error: "Invalid stop transaction" });
					return;
				}
				fence = { revision, instance };
			}
			if (options.requestStop) {
				if (!await options.requestStop(shutdown, fence)) reply(res, 409, { error: "Stop superseded by a newer user action" });
			} else await shutdown();
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
		server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No Hub TCP address");
	origin = `http://127.0.0.1:${address.port}`;
	const unsubscribe = source.subscribe(refresh);
	refresh();
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
		inspections.length = 0;
		presentations.clear();
		await options.notifications?.close();
		await acknowledgements.flush();
		for (const res of streams) res.end();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections();
		});
		options.onStop?.();
	}

	return { origin, close };
}
