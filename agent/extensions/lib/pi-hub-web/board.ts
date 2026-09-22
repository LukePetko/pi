import type { HubSession, HubSnapshot } from "../pi-hub-web-server.ts";
import type { Bucket } from "../hub-attention.ts";

export const CHECKIN_MS = 25 * 60_000;
export const ARCHIVE_MS = 72 * 60 * 60_000;
export const BUCKETS: Bucket[] = ["NEEDS_YOU", "REVIEW", "WORKING", "PARKED"];
export const bucketOf = (session: HubSession): Bucket => session.bucket ?? "PARKED";

export function compareSessions(a: HubSession, b: HubSession): number {
	const bucket = bucketOf(a);
	const group = BUCKETS.indexOf(bucket) - BUCKETS.indexOf(bucketOf(b));
	if (group) return group;
	let order = 0;
	if (bucket === "NEEDS_YOU") order = Number(b.risk === "high") - Number(a.risk === "high") || (a.enteredStateAt ?? 0) - (b.enteredStateAt ?? 0);
	else if (bucket === "REVIEW") order = (b.lastAgentEnd ?? 0) - (a.lastAgentEnd ?? 0);
	else if (bucket === "WORKING") order = b.lastActivity - a.lastActivity;
	else order = (b.lastAgentEnd ?? b.startedAt) - (a.lastAgentEnd ?? a.startedAt);
	return order || a.id.localeCompare(b.id);
}

export function changedSessions(displayed: HubSnapshot, pending: HubSnapshot): number {
	const old = new Map(displayed.sessions.map(session => [session.id, JSON.stringify(session)]));
	let changes = 0;
	for (const session of pending.sessions) {
		if (old.get(session.id) !== JSON.stringify(session)) changes++;
		old.delete(session.id);
	}
	return changes + old.size;
}

/** High-risk breakthrough updates only affected sessions; unrelated changes remain frozen. */
export function highRiskBreakthrough(displayed: HubSnapshot, pending: HubSnapshot): HubSnapshot {
	const old = new Map(displayed.sessions.map(session => [session.id, session]));
	let changed = false;
	for (const session of pending.sessions) {
		if (bucketOf(session) !== "NEEDS_YOU") continue;
		const known = old.get(session.id);
		if (session.permissions?.some(permission => permission.risk === "high" && !known?.permissions?.some(item => item.id === permission.id && item.risk === "high"))) {
			old.set(session.id, session); changed = true;
		}
	}
	return changed ? { ...displayed, sessions: [...old.values()] } : displayed;
}

export class CheckinBoard {
	pending: HubSnapshot = { connected: false, sessions: [] };
	displayed: HubSnapshot = this.pending;
	live = false;
	initialized = false;
	appliedAt: number;
	nextCheckin: number;
	private readonly permissionFollowups = new Map<string, { session: HubSession; requestId: string; expiresAt: number }>();
	constructor(now = Date.now()) { this.appliedAt = now; this.nextCheckin = now + CHECKIN_MS; }
	/** Follow one successful gate action through its asynchronous prompt-end publication. */
	followPermission(acted: HubSession, requestId: string, response: HubSession | undefined, now = Date.now()): boolean {
		const session = response ?? acted;
		if (session.id !== acted.id || session.pid !== acted.pid || session.startedAt !== acted.startedAt
			|| !acted.endpointEpoch || session.endpointEpoch !== acted.endpointEpoch
			|| (acted.lifecycleGeneration !== undefined && session.lifecycleGeneration !== acted.lifecycleGeneration)) return false;
		if (session.turnState !== "prompt" || !session.endpointEpoch || !session.lifecycleGeneration
			|| session.lifecycleRevision === undefined) return false;
		this.permissionFollowups.set(session.id, { session, requestId, expiresAt: now + 5_000 });
		return this.receive(this.pending, now);
	}
	receive(snapshot: HubSnapshot, now = Date.now()): boolean {
		this.pending = snapshot;
		if (!this.initialized || this.live) {
			this.permissionFollowups.clear();
			this.apply(now);
			return true;
		}
		let next = highRiskBreakthrough(this.displayed, snapshot);
		for (const [id, followup] of this.permissionFollowups) {
			const current = snapshot.sessions.find((session) => session.id === id);
			const prior = followup.session;
			if (!snapshot.connected || now >= followup.expiresAt || !current || current.pid !== prior.pid
				|| current.startedAt !== prior.startedAt || current.endpointEpoch !== prior.endpointEpoch
				|| current.lifecycleGeneration !== prior.lifecycleGeneration) {
				this.permissionFollowups.delete(id);
				continue;
			}
			if (current.permissions?.some((permission) => permission.id === followup.requestId)
				|| (current.lifecycleRevision ?? -1) <= prior.lifecycleRevision!
				|| (current.turnState === "prompt" && current.enteredStateAt === prior.enteredStateAt
					&& !current.permissions?.length)) continue;
			// Apply authoritative state, including a genuinely new prompt, never invent running.
			next = { ...next, sessions: next.sessions.map((session) => session.id === id ? current : session) };
			this.permissionFollowups.delete(id);
		}
		if (next === this.displayed) return false;
		this.displayed = next;
		return true;
	}
	apply(now = Date.now()): void {
		this.displayed = this.pending;
		this.appliedAt = now;
		this.initialized ||= this.pending.connected;
	}
	setLive(live: boolean, now = Date.now()): void { this.live = live; if (live) this.apply(now); }
	tick(now = Date.now()): boolean {
		for (const [id, followup] of this.permissionFollowups) {
			if (now >= followup.expiresAt) this.permissionFollowups.delete(id);
		}
		if (now < this.nextCheckin) return false;
		this.nextCheckin += (Math.floor((now - this.nextCheckin) / CHECKIN_MS) + 1) * CHECKIN_MS;
		if (this.live || !this.initialized) return false;
		this.apply(now);
		return true;
	}
}
