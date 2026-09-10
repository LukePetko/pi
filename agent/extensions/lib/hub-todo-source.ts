import { join } from "node:path";
import { readHubTodos, type HubTodos } from "./hub-todos.ts";
import { hubStateDir } from "./pi-hub-web-launcher.ts";
import type { HubSnapshot, HubSource } from "./pi-hub-web-server.ts";

type Session = HubSnapshot["sessions"][number];
const identityKey = (session: Session) => JSON.stringify([session.id, session.pid, session.startedAt]);

/** Enrich presence snapshots without querying agents or reading their transcripts. */
export function withHubTodos(
	source: HubSource,
	options: { directory?: string; pollMs?: number } = {},
): HubSource {
	const directory = options.directory ?? join(hubStateDir(), "todos");
	const listeners = new Set<() => void>();
	let todos = new Map<string, HubTodos>();
	let signature = "";
	let revision = 0;
	let refreshing = false;
	let dirty = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;

	function publish(): void {
		for (const listener of listeners) listener();
	}

	async function refresh(): Promise<void> {
		if (listeners.size === 0) return;
		if (refreshing) { dirty = true; return; }
		refreshing = true;
		dirty = false;
		const generation = revision;
		try {
			const state = source.snapshot();
			const sessions = state.connected ? state.sessions : [];
			const entries = await Promise.all(sessions.map(async (session) =>
				[identityKey(session), await readHubTodos(directory, session)] as const));
			if (generation !== revision || listeners.size === 0) return;
			const next = new Map(entries.filter((entry): entry is readonly [string, HubTodos] => entry[1] !== undefined));
			const nextSignature = JSON.stringify([...next]);
			if (nextSignature !== signature) {
				todos = next;
				signature = nextSignature;
				publish();
			}
		} finally {
			refreshing = false;
			if (dirty && listeners.size > 0) void refresh();
		}
	}

	return {
		snapshot() {
			const state = source.snapshot();
			return {
				...state,
				sessions: state.sessions.map((session) => ({
					...session, todos: state.connected ? todos.get(identityKey(session)) : undefined,
				})),
			};
		},
		resolveSession: (id) => source.resolveSession(id),
		subscribe(listener) {
			listeners.add(listener);
			if (listeners.size === 1) {
				unsubscribe = source.subscribe(() => {
					revision++;
					publish();
					void refresh();
				});
				timer = setInterval(() => void refresh(), options.pollMs ?? 1_000);
				timer.unref();
				void refresh();
			}
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					revision++;
					clearInterval(timer);
					unsubscribe?.();
					todos.clear();
					signature = "";
				}
			};
		},
	};
}
