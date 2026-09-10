import { randomUUID } from "node:crypto";
import { IntercomClient } from "../../npm/node_modules/pi-intercom/broker/client.ts";
import { spawnBrokerIfNeeded } from "../../npm/node_modules/pi-intercom/broker/spawn.ts";
import { loadConfig } from "../../npm/node_modules/pi-intercom/config.ts";
import type { SessionInfo } from "../../npm/node_modules/pi-intercom/types.ts";
import type { HubSource } from "./pi-hub-web-server.ts";

/** One scoped Intercom connection for the whole dashboard, never one per browser. */
export class IntercomHubSource implements HubSource {
	private client: IntercomClient | undefined;
	private sessions: SessionInfo[] = [];
	private connected = false;
	private stopped = false;
	private refreshing = false;
	private dirty = false;
	private retry?: ReturnType<typeof setTimeout>;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private readonly listeners = new Set<() => void>();
	private readonly id = randomUUID();

	snapshot() {
		return { connected: this.connected, sessions: this.sessions };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	private publish(): void {
		for (const listener of this.listeners) listener();
	}

	private scheduleRefresh(): void {
		this.dirty = true;
		if (this.stopped || this.refreshing || this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, 50);
	}

	private async refresh(): Promise<void> {
		const client = this.client;
		if (!client?.isConnected() || this.stopped) return;
		this.refreshing = true;
		this.dirty = false;
		try {
			const sessions = await client.listSessions({ timeoutMs: 5_000 });
			if (this.stopped || this.client !== client) return;
			this.sessions = sessions.filter((session) => session.id !== client.sessionId);
			this.connected = true;
			this.publish();
		} catch {
			if (!this.stopped && this.client === client) {
				this.connected = false;
				this.sessions = [];
				this.publish();
				this.dirty = true;
			}
		} finally {
			this.refreshing = false;
			if (this.dirty && !this.stopped) this.scheduleRefresh();
		}
	}

	async start(): Promise<void> {
		if (this.stopped) return;
		const client = new IntercomClient();
		this.client = client;
		client.on("error", () => { /* disconnected owns recovery */ });
		client.on("disconnected", () => {
			if (this.stopped || this.client !== client) return;
			this.connected = false;
			this.sessions = [];
			this.publish();
			this.scheduleReconnect();
		});
		for (const event of ["session_joined", "session_left", "presence_update"]) {
			client.on(event, () => this.scheduleRefresh());
		}
		try {
			const config = loadConfig();
			if (!config.enabled) throw new Error("Intercom is disabled");
			await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
			if (this.stopped) return;
			await client.connect({
				name: "Pi Hub web (dashboard)",
				cwd: process.cwd(),
				model: "dashboard",
				pid: process.pid,
				startedAt: Date.now(),
				lastActivity: Date.now(),
				status: "dashboard",
			}, this.id);
			if (this.stopped) { await client.disconnect(); return; }
			this.scheduleRefresh();
		} catch {
			await client.disconnect();
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.retry) return;
		this.retry = setTimeout(() => {
			this.retry = undefined;
			void this.start();
		}, 2_000);
	}

	async resolveSession(id: string): Promise<SessionInfo | undefined> {
		const client = this.client;
		if (this.stopped || !client?.isConnected()) return undefined;
		const sessions = await client.listSessions({ timeoutMs: 5_000 });
		if (this.stopped || this.client !== client || id === client.sessionId) return undefined;
		return sessions.find((session) => session.id === id);
	}

	async close(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.retry);
		clearTimeout(this.refreshTimer);
		this.listeners.clear();
		await this.client?.disconnect();
	}
}
