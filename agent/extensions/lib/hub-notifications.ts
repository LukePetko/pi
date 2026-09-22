import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicPrivateJson } from "./pi-hub-service-control.ts";
import { NotificationError, parseEvent, parseOrigin, uuid, type NotificationEvent, type NotificationOrigin } from "./hub-notification-protocol.ts";

interface Runtime { origin: NotificationOrigin; ended: boolean; updated: number }
export interface HubNotice {
	key: string;
	id: string;
	owner: string;
	generation: string;
	event: NotificationEvent;
	capability: string;
	state: "live" | "terminal";
	updated: number;
	cleaned?: boolean;
	backend: "native" | "terminal";
	showOnly?: boolean;
}
interface Ledger { version: 1; runtimes: Runtime[]; notices: HubNotice[] }
export interface NotificationSender {
	show(notice: HubNotice, origin: NotificationOrigin, live: () => boolean, fallback: () => Promise<boolean>): Promise<void>;
	revoke?(notice: HubNotice): Promise<void>;
	remove(notice: HubNotice): Promise<void>;
	list(notices: HubNotice[]): Promise<string[]>;
}
export interface NotificationAuthority {
	runtimeLiveness?(origin: NotificationOrigin): Promise<"live" | "dead" | "unknown">;
	validate(origin: NotificationOrigin, requestId?: string): Promise<void>;
	focused(origin: NotificationOrigin): Promise<boolean>;
	action(origin: NotificationOrigin, requestId: string | undefined, action: "show" | "accept" | "reject", current: () => boolean, signal: AbortSignal): Promise<void>;
}
function sameSecret(expected: string, actual: string): boolean {
	return /^[a-f0-9]{64}$/.test(expected) && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
const processKey = (o: NotificationOrigin) => `${o.pid}:${o.birth}`;
const RETENTION = 24 * 60 * 60 * 1000;

/** Only durable state mutations are serialized; broker, focus and OS work never hold that queue. */
export async function openHubNotifications(options: {
	file: string; scope: string; sender: NotificationSender; authority: NotificationAuthority;
	now?: () => number; pollMs?: number; limit?: number; report?: (error: unknown) => void;
}) {
	const { sender, authority } = options;
	const now = options.now ?? Date.now;
	const limit = options.limit ?? 4096;
	const report = options.report ?? ((error) => console.error("Hub notifications:", error));
	const owner = createHash("sha256").update(options.scope).digest("hex").slice(0, 24);
	let ledger: Ledger = { version: 1, runtimes: [], notices: [] };
	try {
		const data = await readFile(options.file, "utf8");
		if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error("Notification ledger too large");
		ledger = JSON.parse(data);
		if (ledger.version !== 1 || !Array.isArray(ledger.runtimes) || !Array.isArray(ledger.notices) || ledger.runtimes.length > limit || ledger.notices.length > limit) throw new Error("Invalid notification ledger");
		for (const r of ledger.runtimes) {
			parseOrigin(r.origin);
			if (typeof r.ended !== "boolean" || !Number.isFinite(r.updated)) throw new Error("Invalid notification runtime ledger");
		}
		for (const n of ledger.notices) {
			parseEvent(n.event);
			if (n.owner !== owner || !uuid(n.id) || n.generation !== n.event.generation || typeof n.key !== "string" || n.key.length > 512 || !["native", "terminal"].includes(n.backend) || !["live", "terminal"].includes(n.state) || !Number.isFinite(n.updated) || typeof n.capability !== "string" || (n.state === "live" ? !/^[a-f0-9]{64}$/.test(n.capability) : n.capability !== "")) throw new Error("Invalid notification record ledger");
		}
	} catch (error: any) { if (error.code !== "ENOENT") throw error; }
	const active = new Set<string>(); // Disk registrations alone never confer action authority.
	const actions = new Map<string, AbortController>();
	const work = new Set<Promise<void>>();
	const delivering = new Set<string>();
	const removals = new Map<string, { notice: HubNotice; again: boolean }>();
	const removalQueue: { notice: HubNotice; again: boolean }[] = [];
	let removing = 0;
	let stopped = false;
	let sealed = false;
	let closePromise: Promise<void> | undefined;
	let serial: Promise<unknown> = Promise.resolve();
	function transaction<T>(fn: () => Promise<T>): Promise<T> {
		const next = serial.then(fn);
		serial = next.catch(() => {});
		return next;
	}
	function track(promise: Promise<void>) {
		work.add(promise);
		void promise.catch(report).finally(() => work.delete(promise));
	}
	function own<T>(promise: Promise<T>): Promise<T> {
		track(promise.then(() => {}, () => {}));
		return promise;
	}
	function compact() {
		ledger.notices = ledger.notices.filter(n => n.state === "live" || !n.cleaned || n.updated > now() - RETENTION);
		ledger.runtimes = ledger.runtimes.filter(r => !r.ended || r.updated > now() - RETENTION || ledger.notices.some(n => n.generation === r.origin.generation && n.state === "live"));
	}
	async function persist() {
		// Durable close relinquishes writer authority. Late old OS/broker completions
		// must never rename an old snapshot over a replacement daemon's ledger.
		if (sealed) return;
		try { await atomicPrivateJson(options.file, ledger); }
		catch (error) { stopped = true; active.clear(); for (const controller of actions.values()) controller.abort(); throw error; }
	}
	const findRuntime = (generation: string) => ledger.runtimes.find(r => r.origin.generation === generation);
	const live = (n: HubNotice) => !stopped && n.state === "live" && active.has(n.generation);
	function runtime(generation: string) {
		const r = findRuntime(generation);
		if (stopped || !r || r.ended || !active.has(generation)) throw new NotificationError(409, "Notification runtime inactive; register again");
		return r;
	}
	function pumpRemovals() {
		while (removing < 4 && removalQueue.length) {
			const item = removalQueue.shift()!;
			removing++;
			track((async () => {
				try {
					do { item.again = false; await sender.remove(item.notice); } while (item.again);
					await transaction(async () => {
						if (item.notice.state === "terminal") { item.notice.cleaned = !item.again; await persist(); }
					});
				} finally {
					if (item.again) removalQueue.push(item); else removals.delete(item.notice.id);
					removing--; pumpRemovals();
				}
			})());
		}
	}
	function cleanup(n: HubNotice) {
		const existing = removals.get(n.id);
		if (existing) { existing.again = true; return; }
		const item = { notice: n, again: false };
		removals.set(n.id, item);
		track((async () => {
			// Record revocation must not wait behind another origin's slow OS removal.
			try { await sender.revoke?.(n); } catch (error) { report(error); }
			removalQueue.push(item); pumpRemovals();
		})());
	}
	/** Called under transaction; removal is scheduled only after revocation is durable. */
	async function terminate(notices: HubNotice[]) {
		for (const n of notices) {
			n.state = "terminal"; n.capability = ""; n.updated = now(); n.cleaned = false;
			actions.get(n.id)?.abort();
		}
		await persist();
		for (const n of notices) cleanup(n);
	}
	function dispatch(n: HubNotice, origin: NotificationOrigin) {
		delivering.add(n.id);
		const current = () => live(n) && findRuntime(n.generation)?.origin === origin;
		track((async () => {
			try {
				await authority.validate(origin, n.event.requestId);
				if (!current()) return;
				const focused = await authority.focused(origin);
				if (!current()) return;
				if (focused) {
					await transaction(async () => { if (current()) await terminate([n]); });
					return;
				}
				await sender.show(n, origin, current, () => transaction(async () => {
					if (!current()) return false;
					n.backend = "terminal"; n.showOnly = true; await persist(); return true;
				}));
			} catch (error) {
				report(error);
				await transaction(async () => { if (current()) await terminate([n]); });
			} finally {
				delivering.delete(n.id);
				if (n.state === "terminal" || stopped) cleanup(n);
			}
		})());
	}
	function checkRegistration(origin: NotificationOrigin) {
		if (stopped) throw new NotificationError(503, "Notifications stopped");
		const collision = ledger.runtimes.find(r => r.origin.generation === origin.generation && processKey(r.origin) !== processKey(origin));
		if (collision) throw new NotificationError(409, "Notification generation collision");
		const previous = ledger.runtimes.find(r => processKey(r.origin) === processKey(origin));
		if (previous) {
			if (BigInt(origin.sequence) < BigInt(previous.origin.sequence) || previous.ended && origin.generation === previous.origin.generation) throw new NotificationError(409, "Stale notification runtime");
			if (origin.sequence === previous.origin.sequence) {
				const stable = (o: NotificationOrigin) => JSON.stringify([o.pid, o.birth, o.session, o.generation, o.sequence, o.tmuxSocket, o.broker?.id]);
				if (stable(origin) !== stable(previous.origin) || BigInt(origin.bindingSequence) < BigInt(previous.origin.bindingSequence) || origin.bindingSequence === previous.origin.bindingSequence && JSON.stringify(origin) !== JSON.stringify(previous.origin)) throw new NotificationError(409, "Stale notification binding");
			} else if (origin.generation === previous.origin.generation) throw new NotificationError(409, "Runtime nonce reused");
		}
		return previous;
	}
	async function register(value: unknown) {
		const origin = parseOrigin(value);
		checkRegistration(origin);
		await authority.validate(origin); // Slow origin cannot block unrelated terminal events.
		return transaction(async () => {
			const previous = checkRegistration(origin); // Fence any newer registration during validation.
			compact();
			if (previous?.origin.generation !== origin.generation) {
				if (previous) {
					active.delete(previous.origin.generation);
					await terminate(ledger.notices.filter(n => n.generation === previous.origin.generation && n.state === "live"));
					ledger.runtimes = ledger.runtimes.filter(r => r !== previous);
				}
				if (ledger.runtimes.length >= limit) throw new NotificationError(429, "Notification runtime capacity reached");
				ledger.runtimes.push({ origin, ended: false, updated: now() });
			} else if (JSON.stringify(previous.origin) !== JSON.stringify(origin)) {
				for (const n of ledger.notices.filter(n => n.generation === origin.generation)) actions.get(n.id)?.abort();
				previous.origin = origin;
			}
			await persist(); active.add(origin.generation);
			return { ok: true };
		});
	}
	function keyFor(event: NotificationEvent) {
		return `${event.generation}:${event.kind.startsWith("permission-") ? `permission:${event.noticeId}` : event.eventId}`;
	}
	async function event(value: unknown) {
		const event = parseEvent(value);
		// Cleanup carries no approval authority. The authenticated exact stored generation
		// may revoke its own notices even if its process died or its broker binding changed.
		if (event.kind === "session-ended" || event.kind === "permission-resolved") {
			return transaction(async () => {
				if (stopped) throw new NotificationError(503, "Notifications stopped");
				const r = findRuntime(event.generation);
				const prior = ledger.notices.find(n => n.key === keyFor(event));
				if (!r && !prior) throw new NotificationError(409, "Notification runtime inactive");
				if (event.kind === "session-ended") {
					if (r) { r.ended = true; r.updated = now(); }
					active.delete(event.generation);
					await terminate(ledger.notices.filter(n => n.generation === event.generation && n.state === "live"));
				} else if (prior) {
					if (prior.state === "live") await terminate([prior]);
				} else {
					compact();
					if (ledger.notices.length >= limit) throw new NotificationError(429, "Notification ledger capacity reached");
					ledger.notices.push({ key: keyFor(event), id: randomUUID(), owner, generation: event.generation, event, capability: "", state: "terminal", backend: "native", cleaned: true, updated: now() });
					await persist();
				}
				return { ok: true };
			});
		}
		const r = runtime(event.generation);
		const origin = r.origin;
		if (event.bindingSequence !== origin.bindingSequence) throw new NotificationError(409, "Stale notification event binding");
		await authority.validate(origin, event.requestId);
		return transaction(async () => {
			if (runtime(event.generation).origin !== origin) throw new NotificationError(409, "Stale notification event binding");
			const key = keyFor(event);
			const prior = ledger.notices.find(n => n.key === key || n.generation === event.generation && n.event.eventId === event.eventId);
			if (prior) return { ok: true, duplicate: true };
			compact();
			if (ledger.notices.length >= limit) throw new NotificationError(429, "Notification ledger capacity reached");
			const n: HubNotice = { key, id: randomUUID(), owner, generation: event.generation, event, capability: randomBytes(32).toString("hex"), state: "live", backend: event.kind === "completion" ? "terminal" : "native", updated: now() };
			ledger.notices.push(n); await persist(); dispatch(n, origin);
			return { ok: true };
		});
	}
	async function action(value: any) {
		if (!value || typeof value.id !== "string" || typeof value.capability !== "string" || !["show", "accept", "reject", "dismiss"].includes(value.action) || Object.keys(value).some(k => !["id", "capability", "action"].includes(k))) throw new NotificationError(400, "Invalid native action");
		const reservation = await transaction(async () => {
			const n = ledger.notices.find(n => n.id === value.id);
			if (!n || !live(n) || !sameSecret(n.capability, value.capability)) throw new NotificationError(403, "Native action revoked");
			if (n.showOnly && ["accept", "reject"].includes(value.action)) throw new NotificationError(403, "Show-only fallback");
			if (actions.has(n.id)) throw new NotificationError(409, "Native action already in progress");
			const origin = runtime(n.generation).origin;
			const controller = new AbortController(); actions.set(n.id, controller);
			return { n, origin, controller };
		});
		const { n, origin, controller } = reservation;
		const current = () => live(n) && !controller.signal.aborted && findRuntime(n.generation)?.origin === origin;
		try {
			if (value.action !== "dismiss") await authority.action(origin, n.event.requestId, value.action, current, controller.signal);
			return await transaction(async () => {
				if (!current()) throw new NotificationError(409, "Native action revoked");
				await terminate([n]); return { ok: true };
			});
		} finally { if (actions.get(n.id) === controller) actions.delete(n.id); }
	}
	let reconcilingRuntimes = false;
	async function reconcileRuntimes() {
		if (stopped || reconcilingRuntimes || !authority.runtimeLiveness) return;
		reconcilingRuntimes = true;
		try {
			const pending = ledger.runtimes.filter((r) => !r.ended);
			async function check(r: Runtime) {
				const origin = r.origin;
				let status: "live" | "dead" | "unknown";
				try {
					status = await authority.runtimeLiveness!(origin);
				} catch {
					return; // A failed probe is unknown, never death.
				}
				if (status !== "dead") return;
				await transaction(async () => {
					if (stopped || r.ended || findRuntime(origin.generation) !== r || r.origin !== origin) return;
					r.ended = true;
					r.updated = now(); // Keep replay fencing for a full horizon after confirmation.
					active.delete(origin.generation);
					await terminate(ledger.notices.filter((n) => n.generation === origin.generation && n.state === "live"));
				});
			}
			for (let i = 0; i < pending.length && !stopped; i += 4)
				await Promise.all(pending.slice(i, i + 4).map(check));
			await transaction(async () => {
				if (stopped) return;
				const runtimes = ledger.runtimes.length, notices = ledger.notices.length;
				compact();
				if (runtimes !== ledger.runtimes.length || notices !== ledger.notices.length) await persist();
			});
		} finally {
			reconcilingRuntimes = false;
		}
	}
	let polling = false;
	async function pollNotices() {
		if (stopped || polling) return;
		polling = true;
		try {
			const pending = ledger.notices.filter(n => n.state === "live");
			// A terminal-notifier child can outlive a daemon crash. Recheck recently
			// revoked IDs during the retry horizon so a late old add is withdrawn too.
			const candidates = ledger.notices.filter(n => n.state === "live" || n.updated > now() - 300000 && n.event.kind !== "permission-resolved");
			let present: string[] | undefined;
			if (!delivering.size && candidates.length) {
				try { present = await sender.list(candidates); } catch { /* Unknown OS state is not dismissal. */ }
			}
			if (present) await transaction(async () => {
				const late = candidates.filter(n => n.state === "terminal" && present!.includes(n.id));
				if (late.length) await terminate(late);
			});
			async function check(n: HubNotice) {
				const r = findRuntime(n.generation);
				const origin = r?.origin;
				const unchanged = () => !stopped && n.state === "live" && findRuntime(n.generation)?.origin === origin;
				let terminal = !r || r.ended || !!present && !present.includes(n.id);
				if (!terminal && origin) {
					try {
						await authority.validate(origin, n.event.requestId);
						if (unchanged() && active.has(n.generation)) terminal = await authority.focused(origin);
					} catch (error: any) { terminal = error.status === 409; }
				}
				if (terminal) await transaction(async () => { if (unchanged()) await terminate([n]); });
			}
			for (let i = 0; i < pending.length && !stopped; i += 4) await Promise.all(pending.slice(i, i + 4).map(check));
		} finally { polling = false; }
	}
	async function poll() {
		// Each lane is non-overlapping; a blocked OS list cannot stall process retirement.
		await Promise.all([reconcileRuntimes(), pollNotices()]);
	}
	// Boot reconciliation never re-adds a notice. Kept capabilities remain inert until
	// fresh registration; terminal cleanup does not hold startup on an OS operation.
	const restored = ledger.notices.filter(n => n.state === "live");
	for (const n of ledger.notices.filter(n => n.state === "terminal" && !n.cleaned)) cleanup(n);
	await transaction(async () => { compact(); await persist(); });
	if (restored.length) track((async () => {
		const present = await sender.list(restored);
		await transaction(() => terminate(restored.filter(n => n.state === "live" && !present.includes(n.id))));
	})());
	const timer = setInterval(() => { void own(poll()).catch(report); }, options.pollMs ?? 1000); timer.unref();
	return {
		register: (value: unknown) => own(register(value)),
		event: (value: unknown) => own(event(value)),
		action: (value: unknown) => own(action(value)),
		poll: () => own(poll()),
		async drain() { do { await serial; await Promise.allSettled([...work]); } while (work.size); await serial; },
		close() {
			if (closePromise) return closePromise;
			stopped = true; active.clear(); clearInterval(timer);
			for (const controller of actions.values()) controller.abort();
			closePromise = transaction(async () => {
				try { await terminate(ledger.notices.filter(n => n.state === "live")); }
				finally { sealed = true; }
			});
			return closePromise;
		},
	};
}
