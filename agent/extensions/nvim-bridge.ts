import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import net from "node:net";

const HOST = process.env.PI_NVIM_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.PI_NVIM_BRIDGE_PORT || "47631");

type Json = Record<string, any>;

type Client = {
	id: number;
	socket: net.Socket;
	buffer: string;
};

export default function nvimBridge(pi: ExtensionAPI) {
	let server: net.Server | undefined;
	let nextClientId = 1;
	const clients = new Map<number, Client>();
	let latestContext: Json | undefined;
	const pending = new Map<string, (msg: Json) => void>();

	function notify(message: string, level: "info" | "warn" | "error" = "info") {
		// ctx.ui is only available in event/command/tool contexts, so use custom messages for passive status.
		pi.sendMessage(
			{ customType: "nvim-bridge", content: message, display: false },
			{ deliverAs: "nextTurn" },
		);
	}

	function send(client: Client, msg: Json) {
		if (!client.socket.destroyed)
			client.socket.write(`${JSON.stringify(msg)}\n`);
	}

	function broadcast(msg: Json) {
		for (const client of clients.values()) send(client, msg);
	}

	function firstClient(): Client | undefined {
		return [...clients.values()][0];
	}

	function requestNvim(
		type: string,
		payload: Json = {},
		timeoutMs = 3000,
	): Promise<Json> {
		const client = firstClient();
		if (!client)
			throw new Error("No Neovim client connected to pi nvim bridge");
		const id = `pi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		const msg = { id, type, ...payload };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`Timed out waiting for Neovim response to ${type}`));
			}, timeoutMs);
			pending.set(id, (response) => {
				clearTimeout(timer);
				if (response.error) reject(new Error(String(response.error)));
				else resolve(response);
			});
			send(client, msg);
		});
	}

	function handleMessage(client: Client, msg: Json) {
		if (msg.replyTo && pending.has(msg.replyTo)) {
			pending.get(msg.replyTo)!(msg);
			pending.delete(msg.replyTo);
			return;
		}

		switch (msg.type) {
			case "hello":
				send(client, {
					type: "hello",
					from: "pi",
					clientId: client.id,
					port: PORT,
				});
				break;
			case "context":
				latestContext = {
					...msg,
					receivedAt: new Date().toISOString(),
					clientId: client.id,
				};
				pi.appendEntry("nvim-context", latestContext);
				notify(`Received nvim ${msg.kind || "context"}`);
				break;
			case "prompt": {
				const text = String(msg.message || "").trim();
				if (!text) return;
				const ctxText = msg.context
					? `\n\nNvim context:\n\`\`\`\n${typeof msg.context === "string" ? msg.context : JSON.stringify(msg.context, null, 2)}\n\`\`\``
					: "";
				pi.sendUserMessage(`${text}${ctxText}`, {
					deliverAs: msg.deliverAs === "followUp" ? "followUp" : "steer",
				});
				break;
			}
			default:
				send(client, {
					type: "error",
					error: `Unknown message type: ${msg.type || "<missing>"}`,
				});
		}
	}

	function startServer() {
		if (server) return;
		server = net.createServer((socket) => {
			const client: Client = { id: nextClientId++, socket, buffer: "" };
			clients.set(client.id, client);
			socket.setEncoding("utf8");
			send(client, {
				type: "hello",
				from: "pi",
				clientId: client.id,
				port: PORT,
			});

			socket.on("data", (chunk) => {
				client.buffer += chunk;
				let idx: number;
				while ((idx = client.buffer.indexOf("\n")) >= 0) {
					const line = client.buffer.slice(0, idx).replace(/\r$/, "");
					client.buffer = client.buffer.slice(idx + 1);
					if (!line.trim()) continue;
					try {
						handleMessage(client, JSON.parse(line));
					} catch (error) {
						send(client, {
							type: "error",
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			});

			socket.on("close", () => clients.delete(client.id));
			socket.on("error", () => clients.delete(client.id));
		});

		server.listen(PORT, HOST, () =>
			notify(`nvim bridge listening on ${HOST}:${PORT}`),
		);
		server.on("error", (error: any) =>
			notify(`nvim bridge error: ${error?.message || error}`, "error"),
		);
	}

	pi.on("session_start", async () => startServer());
	pi.on("session_shutdown", async () => {
		for (const client of clients.values()) client.socket.destroy();
		clients.clear();
		server?.close();
		server = undefined;
	});

	pi.registerCommand("nvim", {
		description:
			"Send latest Neovim context to the agent, or use /nvim pull to request current context",
		handler: async (args, ctx) => {
			const mode = args.trim() || "latest";
			if (mode === "pull") {
				const res = await requestNvim("get_context", {
					kind: "selection_or_buffer",
				});
				latestContext = res.context || res;
			}
			if (!latestContext) {
				ctx.ui.notify(
					"No nvim context yet. Run :PiSendSelection or :PiSendBuffer in nvim.",
					"warn",
				);
				return;
			}
			await ctx.sendUserMessage(
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
				const res = await requestNvim("get_context", { kind });
				context = res.context || res;
				latestContext = context;
			}
			return {
				content: [
					{ type: "text", text: JSON.stringify(context || null, null, 2) },
				],
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
			const res = await requestNvim("open_file", params);
			return {
				content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
			};
		},
	});

	pi.registerTool({
		name: "nvim_show_message",
		label: "Show Message in Neovim",
		description: "Show a short notification in connected Neovim.",
		parameters: Type.Object({ message: Type.String() }),
		async execute(_id, params) {
			broadcast({ type: "show_message", message: params.message });
			return { content: [{ type: "text", text: "sent" }] };
		},
	});
}
