export const NOTIFICATION_API = "/api/v1/notifications/";
export interface NotificationOrigin {
	pid: number;
	birth: string;
	session: string;
	generation: string;
	sequence: string;
	bindingSequence: string;
	tmuxSocket?: string;
	broker?: { id: string; startedAt: number; endpointEpoch: string };
}
export interface NotificationEvent {
	version: 1;
	eventId: string;
	generation: string;
	bindingSequence?: string;
	kind: "completion" | "permission-requested" | "permission-resolved" | "session-ended";
	noticeId?: string;
	requestId?: string;
	cwd?: string;
	title?: string;
	durationMs?: number;
	test?: boolean;
}
export class NotificationError extends Error {
	readonly status: number;
	constructor(status: number, message: string) { super(message); this.status = status; }
}
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
export const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
function keys(value: any, allowed: string[]) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
		throw new NotificationError(400, "Invalid notification data");
}
export function parseOrigin(v: any): NotificationOrigin {
	keys(v, ["pid", "birth", "session", "generation", "sequence", "bindingSequence", "tmuxSocket", "broker"]);
	if (!Number.isSafeInteger(v.pid) || v.pid <= 1 || !text(v.birth, 128) || !text(v.session, 256) || !uuid(v.generation) || typeof v.sequence !== "string" || !/^[1-9]\d{0,29}$/.test(v.sequence) || typeof v.bindingSequence !== "string" || !/^[1-9]\d{0,29}$/.test(v.bindingSequence) || (v.tmuxSocket !== undefined && (!text(v.tmuxSocket, 1024) || !v.tmuxSocket.startsWith("/") || v.tmuxSocket.includes("\0"))))
		throw new NotificationError(400, "Invalid notification origin");
	if (v.broker !== undefined) {
		keys(v.broker, ["id", "startedAt", "endpointEpoch"]);
		if (!text(v.broker.id, 256) || !Number.isFinite(v.broker.startedAt) || !text(v.broker.endpointEpoch, 256)) throw new NotificationError(400, "Invalid broker binding");
	}
	return v;
}
export function parseEvent(v: any): NotificationEvent {
	keys(v, ["version", "eventId", "generation", "bindingSequence", "kind", "noticeId", "requestId", "cwd", "title", "durationMs", "test"]);
	if (typeof v.bindingSequence !== "string" || !/^[1-9]\d{0,29}$/.test(v.bindingSequence) || v.version !== 1 || !uuid(v.eventId) || !uuid(v.generation) || !["completion", "permission-requested", "permission-resolved", "session-ended"].includes(v.kind)) throw new NotificationError(400, "Invalid notification event");
	if (v.kind.startsWith("permission-") && !text(v.noticeId, 256)) throw new NotificationError(400, "Notice identity required");
	if (v.requestId !== undefined && (!uuid(v.requestId) || v.noticeId !== v.requestId || v.kind !== "permission-requested")) throw new NotificationError(400, "Invalid request identity");
	if (v.cwd !== undefined && !text(v.cwd, 1024) || v.title !== undefined && !text(v.title, 1024) || v.durationMs !== undefined && (!Number.isFinite(v.durationMs) || v.durationMs < 0 || v.durationMs > 31536000000) || v.test !== undefined && typeof v.test !== "boolean") throw new NotificationError(400, "Invalid notification presentation");
	if (["completion", "permission-requested"].includes(v.kind) && !v.cwd || v.kind === "permission-requested" && !v.title) throw new NotificationError(400, "Presentation required");
	return v;
}
