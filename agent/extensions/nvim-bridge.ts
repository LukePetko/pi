// @ts-nocheck
import { execFile } from "node:child_process";
import * as net from "node:net";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { focusSubagentWindow } from "./lib/subagent-tmux";

const HOST = process.env.PI_NVIM_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.PI_NVIM_BRIDGE_PORT || "47631");
const HEARTBEAT_MS = 5_000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 2_000;

type Json = Record<string, any>;
type Role = "unknown" | "nvim" | "pi";

type Client = {
	id: number;
	role: Role;
	socket: net.Socket;
	buffer: string;
	registered?: PiRegistration;
	selectedTargetSessionId?: string;
	tmuxPane?: string;
	tmuxClientTty?: string;
};

type PiRegistration = {
	role: "pi";
	sessionId: string;
	instanceId: string;
	cwd: string;
	pid: number;
	tmuxPane?: string;
	startedAt: string;
	lastSeen: string;
};

type BridgeGlobal = {
	cleanup?: () => void;
};

const INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const BRIDGE_GLOBAL_KEY = "__piNvimBridgeCleanup";

function now() {
	return new Date().toISOString();
}

function tmuxPane() {
	return process.env.TMUX_PANE || undefined;
}

function cwdScore(file: string | undefined, cwd: string): number {
	if (!file) return 0;
	const normalized = file.endsWith("/") ? file : `${file}/`;
	const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return normalized.startsWith(root) ? root.length : 0;
}

export default function nvimBridge(pi: ExtensionAPI) {
	const bridgeGlobal = globalThis as typeof globalThis &
		Record<string, BridgeGlobal | undefined>;
	bridgeGlobal[BRIDGE_GLOBAL_KEY]?.cleanup?.();

	let server: net.Server | undefined;
	let brokerSocket: net.Socket | undefined;
	let brokerBuffer = "";
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let nextClientId = 1;
	let isBroker = false;
	let latestContext: Json | undefined;
	let active = true;
	let currentRegistration: PiRegistration = {
		role: "pi",
		sessionId: `pid-${process.pid}`,
		instanceId: INSTANCE_ID,
		cwd: process.cwd(),
		pid: process.pid,
		tmuxPane: tmuxPane(),
		startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
		lastSeen: now(),
	};

	const clients = new Map<number, Client>();
	const pending = new Map<string, (msg: Json) => void>();

	function registration(): PiRegistration {
		return { ...currentRegistration, lastSeen: now() };
	}

	function notify(message: string) {
		if (!active) return;
		try {
			pi.sendMessage(
				{ customType: "nvim-bridge", content: message, display: false },
				{ deliverAs: "nextTurn" },
			);
		} catch {
			// The extension may be shutting down/reloading; ignore stale-runtime notices.
		}
	}

	function sendSocket(socket: net.Socket, msg: Json) {
		if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
	}

	function send(client: Client, msg: Json) {
		sendSocket(client.socket, msg);
	}

	function tmux(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			execFile("tmux", args, { encoding: "utf8" }, (error, stdout) => {
				if (error) reject(error);
				else resolve(stdout.trim());
			});
		});
	}

	async function focusTmuxPane(
		pane?: string,
		clientTty?: string,
	): Promise<void> {
		if (!pane) throw new Error("No tmux pane known");
		const target = await tmux([
			"display-message",
			"-p",
			"-t",
			pane,
			"#{session_name}:#{window_index}.#{pane_index}",
		]);
		const session = target.split(":")[0];
		const window = target.split(".")[0];
		await tmux(
			clientTty
				? ["switch-client", "-c", clientTty, "-t", session]
				: ["switch-client", "-t", session],
		);
		await tmux(["select-window", "-t", window]);
		await tmux(["select-pane", "-t", target]);
	}

	function broadcastToNvim(msg: Json) {
		for (const client of clients.values()) {
			if (client.role === "nvim" || client.role === "unknown")
				send(client, msg);
		}
	}

	function localPiSession(): PiRegistration {
		return registration();
	}

	function allPiSessions(): PiRegistration[] {
		const byKey = new Map<string, PiRegistration>();
		for (const session of [
			localPiSession(),
			...[...clients.values()]
				.filter((client) => client.role === "pi" && client.registered)
				.map((client) => client.registered!),
		]) {
			byKey.set(`${session.sessionId}:${session.pid}:${session.cwd}`, session);
		}
		return [...byKey.values()];
	}

	function targetPiClient(sessionId?: string): Client | "local" | undefined {
		if (!sessionId) return undefined;
		if (localPiSession().sessionId === sessionId) return "local";
		return [...clients.values()].find(
			(client) =>
				client.role === "pi" && client.registered?.sessionId === sessionId,
		);
	}

	function bestPiClient(file?: string): Client | "local" {
		let best: { client: Client | "local"; score: number } = {
			client: "local",
			score: cwdScore(file, localPiSession().cwd),
		};
		for (const client of clients.values()) {
			if (client.role !== "pi" || !client.registered) continue;
			const score = cwdScore(file, client.registered.cwd);
			if (score > best.score) best = { client, score };
		}
		return best.client;
	}

	function acceptContext(msg: Json) {
		if (!active) return;
		latestContext = {
			...msg,
			receivedAt: now(),
			broker: isBroker ? "local" : "remote",
		};
		try {
			pi.appendEntry("nvim-context", latestContext);
		} catch {
			// Ignore messages racing with session replacement/reload.
		}
	}

	function routeContext(msg: Json) {
		const target =
			targetPiClient(msg.targetSessionId || msg.target) ??
			bestPiClient(msg.file);
		if (target === "local") acceptContext(msg);
		else send(target, { type: "context", context: msg });
	}

	function routePrompt(msg: Json) {
		const target =
			targetPiClient(msg.targetSessionId || msg.target) ??
			bestPiClient(msg.context?.file || msg.file);
		if (target !== "local") {
			send(target, {
				type: "prompt",
				message: msg.message,
				context: msg.context,
				deliverAs: msg.deliverAs,
			});
			return;
		}
		const text = String(msg.message || "").trim();
		if (!text || !active) return;
		const ctxText = msg.context
			? `\n\nNvim context:\n\`\`\`\n${typeof msg.context === "string" ? msg.context : JSON.stringify(msg.context, null, 2)}\n\`\`\``
			: "";
		try {
			pi.sendUserMessage(`${text}${ctxText}`, {
				deliverAs: msg.deliverAs === "followUp" ? "followUp" : "steer",
			});
		} catch {
			// Ignore prompts racing with session replacement/reload.
		}
	}

	function firstNvim(): Client | undefined {
		return [...clients.values()].find(
			(client) => client.role === "nvim" || client.role === "unknown",
		);
	}

	function requestViaBroker(
		type: string,
		payload: Json = {},
		timeoutMs = 3000,
	): Promise<Json> {
		const id = `pi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const msg = { id, type, ...payload };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Timed out waiting for ${type}`));
			}, timeoutMs);
			pending.set(id, (response) => {
				clearTimeout(timer);
				if (response.error) reject(new Error(String(response.error)));
				else resolve(response);
			});

			if (isBroker) {
				const nvim = firstNvim();
				if (!nvim) {
					pending.delete(id);
					clearTimeout(timer);
					reject(new Error("No Neovim client connected to nvim broker"));
					return;
				}
				send(nvim, msg);
			} else if (brokerSocket && !brokerSocket.destroyed) {
				sendSocket(brokerSocket, { type: "request_nvim", request: msg });
			} else {
				pending.delete(id);
				clearTimeout(timer);
				reject(new Error("Not connected to nvim broker"));
			}
		});
	}

	function deliverPromptLocally(msg: Json) {
		const text = String(msg.message || "").trim();
		if (!text || !active) return;
		const ctxText = msg.context
			? `\n\nNvim context:\n\`\`\`\n${typeof msg.context === "string" ? msg.context : JSON.stringify(msg.context, null, 2)}\n\`\`\``
			: "";
		try {
			pi.sendUserMessage(`${text}${ctxText}`, {
				deliverAs: msg.deliverAs === "followUp" ? "followUp" : "steer",
			});
		} catch {
			// Ignore prompts racing with session replacement/reload.
		}
	}

	function handlePiSideMessage(msg: Json) {
		if (msg.replyTo && pending.has(msg.replyTo)) {
			pending.get(msg.replyTo)!(msg);
			pending.delete(msg.replyTo);
			return;
		}
		switch (msg.type) {
			case "context":
				acceptContext(msg.context || msg);
				break;
			case "prompt":
				deliverPromptLocally(msg);
				break;
			case "nvim_response":
				if (msg.response?.replyTo && pending.has(msg.response.replyTo)) {
					pending.get(msg.response.replyTo)!(msg.response);
					pending.delete(msg.response.replyTo);
				}
				break;
		}
	}

	function handleBrokerClientMessage(client: Client, msg: Json) {
		if (msg.replyTo) {
			const requestOwner = [...clients.values()].find(
				(candidate) => candidate.role === "pi",
			);
			if (requestOwner)
				send(requestOwner, { type: "nvim_response", response: msg });
			return;
		}

		switch (msg.type) {
			case "hello":
				client.role = msg.role === "pi" ? "pi" : "nvim";
				client.tmuxPane = msg.tmuxPane;
				client.tmuxClientTty = msg.tmuxClientTty;
				send(client, {
					type: "hello",
					from: "pi-broker",
					port: PORT,
					sessions: allPiSessions(),
				});
				break;
			case "register_pi": {
				client.role = "pi";
				const registered = {
					...msg,
					role: "pi",
					lastSeen: now(),
				} as PiRegistration;
				for (const existing of clients.values()) {
					if (
						existing.id !== client.id &&
						existing.role === "pi" &&
						existing.registered &&
						(existing.registered.instanceId === registered.instanceId ||
							(existing.registered.sessionId === registered.sessionId &&
								existing.registered.pid === registered.pid &&
								existing.registered.cwd === registered.cwd))
					) {
						existing.socket.destroy();
						clients.delete(existing.id);
					}
				}
				client.registered = registered;
				send(client, {
					type: "registered",
					broker: true,
					sessions: allPiSessions(),
				});
				broadcastToNvim({ type: "sessions", sessions: allPiSessions() });
				break;
			}
			case "heartbeat":
				client.role = "pi";
				if (client.registered) client.registered.lastSeen = now();
				break;
			case "context":
				client.role = client.role === "unknown" ? "nvim" : client.role;
				routeContext({
					...msg,
					targetSessionId:
						msg.targetSessionId || client.selectedTargetSessionId,
				});
				break;
			case "prompt":
				client.role = client.role === "unknown" ? "nvim" : client.role;
				routePrompt({
					...msg,
					targetSessionId:
						msg.targetSessionId || client.selectedTargetSessionId,
				});
				break;
			case "request_nvim": {
				const nvim = firstNvim();
				if (!nvim)
					send(client, {
						type: "nvim_response",
						response: {
							replyTo: msg.request?.id,
							error: "No Neovim client connected",
						},
					});
				else send(nvim, msg.request);
				break;
			}
			case "list_sessions":
				send(client, { type: "sessions", sessions: allPiSessions() });
				break;
			case "select_session":
				client.role = client.role === "unknown" ? "nvim" : client.role;
				client.selectedTargetSessionId = msg.targetSessionId || msg.sessionId;
				send(client, {
					type: "selected_session",
					targetSessionId: client.selectedTargetSessionId,
					sessions: allPiSessions(),
				});
				break;
			case "focus_pi": {
				const target = targetPiClient(
					msg.targetSessionId || client.selectedTargetSessionId,
				);
				const pane =
					target === "local" ? tmuxPane() : target?.registered?.tmuxPane;
				focusTmuxPane(pane, client.tmuxClientTty)
					.then(() => send(client, { type: "focused_pi", ok: true }))
					.catch((error) =>
						send(client, { type: "error", error: error.message }),
					);
				break;
			}
			case "focus_subagents":
				focusSubagentWindow()
					.then(() => send(client, { type: "focused_subagents", ok: true }))
					.catch((error) =>
						send(client, { type: "error", error: error.message }),
					);
				break;
			default:
				send(client, {
					type: "error",
					error: `Unknown message type: ${msg.type || "<missing>"}`,
				});
		}
	}

	function startBroker() {
		if (server) return;
		server = net.createServer((socket) => {
			const client: Client = {
				id: nextClientId++,
				role: "unknown",
				socket,
				buffer: "",
			};
			clients.set(client.id, client);
			socket.setEncoding("utf8");
			send(client, {
				type: "hello",
				from: "pi-broker",
				port: PORT,
				sessions: allPiSessions(),
			});

			socket.on("data", (chunk) => {
				client.buffer += chunk;
				let idx: number;
				while ((idx = client.buffer.indexOf("\n")) >= 0) {
					const line = client.buffer.slice(0, idx).replace(/\r$/, "");
					client.buffer = client.buffer.slice(idx + 1);
					if (!line.trim()) continue;
					try {
						handleBrokerClientMessage(client, JSON.parse(line));
					} catch (error) {
						send(client, {
							type: "error",
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			});
			socket.on("close", () => {
				clients.delete(client.id);
				broadcastToNvim({ type: "sessions", sessions: allPiSessions() });
			});
			socket.on("error", () => clients.delete(client.id));
		});

		server.once("error", (error: any) => {
			server = undefined;
			if (error?.code === "EADDRINUSE") connectToBroker();
			else notify(`nvim bridge error: ${error?.message || error}`);
		});
		server.listen(PORT, HOST, () => {
			isBroker = true;
			notify(`nvim broker listening on ${HOST}:${PORT}`);
		});
	}

	function scheduleReconnect() {
		if (reconnectTimer) return;
		const delay =
			RECONNECT_MIN_MS +
			Math.floor(Math.random() * (RECONNECT_MAX_MS - RECONNECT_MIN_MS));
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			startBroker();
		}, delay);
	}

	function connectToBroker() {
		if (brokerSocket && !brokerSocket.destroyed) return;
		isBroker = false;
		const socket = net.createConnection({ host: HOST, port: PORT });
		brokerSocket = socket;
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			sendSocket(socket, { type: "register_pi", ...registration() });
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = setInterval(() => {
				if (!socket.destroyed)
					sendSocket(socket, {
						type: "heartbeat",
						sessionId: registration().sessionId,
						lastSeen: now(),
					});
			}, HEARTBEAT_MS);
		});
		socket.on("data", (chunk) => {
			brokerBuffer += chunk;
			let idx: number;
			while ((idx = brokerBuffer.indexOf("\n")) >= 0) {
				const line = brokerBuffer.slice(0, idx).replace(/\r$/, "");
				brokerBuffer = brokerBuffer.slice(idx + 1);
				if (!line.trim()) continue;
				try {
					handlePiSideMessage(JSON.parse(line));
				} catch {
					// Ignore malformed broker messages.
				}
			}
		});
		socket.on("close", () => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			brokerSocket = undefined;
			scheduleReconnect();
		});
		socket.on("error", () => {
			socket.destroy();
		});
	}

	function cleanup() {
		active = false;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		reconnectTimer = undefined;
		heartbeatTimer = undefined;
		for (const client of clients.values()) client.socket.destroy();
		clients.clear();
		brokerSocket?.destroy();
		brokerSocket = undefined;
		server?.close();
		server = undefined;
		isBroker = false;
	}

	bridgeGlobal[BRIDGE_GLOBAL_KEY] = { cleanup };

	pi.on("session_start", async (_event, ctx) => {
		active = true;
		currentRegistration = {
			role: "pi",
			sessionId: ctx.sessionManager.getSessionId() ?? `pid-${process.pid}`,
			instanceId: INSTANCE_ID,
			cwd: ctx.cwd ?? process.cwd(),
			pid: process.pid,
			tmuxPane: tmuxPane(),
			startedAt: currentRegistration.startedAt,
			lastSeen: now(),
		};
		startBroker();
	});
	pi.on("session_shutdown", async () => cleanup());

	async function focusConnectedNvim(): Promise<void> {
		await focusTmuxPane(firstNvim()?.tmuxPane);
	}

	pi.registerShortcut("ctrl+\\", {
		description: "Focus connected Neovim pane",
		handler: async (ctx) => {
			try {
				await focusConnectedNvim();
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"warning",
				);
			}
		},
	});

	pi.registerCommand("nvim", {
		description:
			"Send latest Neovim context to the agent, pull context, or list bridge sessions",
		handler: async (args, ctx) => {
			const mode = args.trim() || "latest";
			if (mode === "sessions") {
				ctx.ui.notify(
					allPiSessions()
						.map((s) => `${s.cwd} ${s.tmuxPane ?? ""}`)
						.join("\n") || "No sessions",
					"info",
				);
				return;
			}
			if (mode === "focus") {
				try {
					await focusConnectedNvim();
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				return;
			}
			if (mode === "subagents") {
				try {
					await focusSubagentWindow();
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"warning",
					);
				}
				return;
			}
			if (mode === "pull") {
				const res = await requestViaBroker("get_context", {
					kind: "selection_or_buffer",
				});
				latestContext = res.context || res;
			}
			if (!latestContext) {
				ctx.ui.notify(
					"No nvim context yet. Send selection/buffer from nvim first.",
					"warning",
				);
				return;
			}
			pi.sendUserMessage(
				`Use this Neovim context:\n\n\`\`\`json\n${JSON.stringify(latestContext, null, 2)}\n\`\`\``,
			);
		},
	});

	pi.registerTool({
		name: "nvim_get_context",
		label: "Get Neovim Context",
		description:
			"Get current selection/buffer context from connected Neovim, or the latest pushed context.",
		promptSnippet: "Get current Neovim selection/buffer context",
		parameters: Type.Object({
			kind: Type.Optional(
				Type.String({
					description: "selection, buffer, diagnostics, or latest",
				}),
			),
		}),
		async execute(_id, params) {
			const kind = params.kind || "latest";
			let context = latestContext;
			if (kind !== "latest") {
				const res = await requestViaBroker("get_context", { kind });
				context = res.context || res;
				latestContext = context;
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify(context || null, null, 2) },
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "nvim_open_file",
		label: "Open File in Neovim",
		description:
			"Ask connected Neovim to open a file and optionally jump to a line/column.",
		promptSnippet: "Open a file/location in connected Neovim",
		parameters: Type.Object({
			file: Type.String(),
			line: Type.Optional(Type.Number()),
			column: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			const res = await requestViaBroker("open_file", params);
			return {
				content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "nvim_show_message",
		label: "Show Message in Neovim",
		description: "Show a short notification in connected Neovim.",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params) {
			if (isBroker)
				broadcastToNvim({ type: "show_message", message: params.message });
			else if (brokerSocket && !brokerSocket.destroyed)
				sendSocket(brokerSocket, {
					type: "request_nvim",
					request: {
						id: `show-${Date.now()}`,
						type: "show_message",
						message: params.message,
					},
				});
			return { content: [{ type: "text", text: "sent" }], details: undefined };
		},
	});
}
