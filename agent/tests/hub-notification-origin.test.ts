import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { notificationOriginAuthority, originCommand } from "../extensions/lib/hub-notification-origin.ts";
import { createPermissionBroker } from "../extensions/lib/hub-permissions.ts";

test("origin authority checks pid/birth/UID, fresh roster/gate and per-origin nondefault tmux socket; focus never targets daemon PID", async t => {
	const root = await realpath(await mkdtemp("/tmp/pi-notice-origin-"));
	const socketPath = join(root, "nondefault.sock"); const socket = createServer(); await new Promise<void>(r => socket.listen(socketPath, r));
	const directory = join(root, "permissions"); const broker = await createPermissionBroker(directory);
	t.after(async () => { await broker.close(); await new Promise<void>(r => socket.close(() => r())); await rm(root, { recursive: true, force: true }); });
	const calls: any[] = []; const pid = 4321; let uid = process.getuid?.(); let born = "birth";
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		if (args.includes("lstart=")) return born;
		if (args.includes("uid=")) return String(uid);
		if (args.includes("-axo")) return `${pid} 1\n9876 1`;
		if (args.includes("list-panes")) return `origin\t@32\t%32\t${pid}`;
		if (args.includes("list-clients")) return "client\t9876\torigin\t10";
		if (args.includes("list-windows")) return "88\twork\tGhostty";
		return "";
	};
	let epoch = "epoch"; let connected = true; let rosterPid = pid; let rosterStartedAt = 1;
	const source = { snapshot: () => ({ connected, sessions: [] }), subscribe: () => () => {}, resolveSession: async () => ({ id: "pi", pid: rosterPid, startedAt: rosterStartedAt, endpointEpoch: epoch } as any) };
	const focused: any[] = [];
	const authority = notificationOriginAuthority(source, directory, { run, focus: async (origin, signal) => { assert.equal(signal.aborted, false); focused.push(origin); } });
	const origin = { pid, birth: "birth", session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1", tmuxSocket: socketPath, broker: { id: "pi", startedAt: 1, endpointEpoch: "epoch" } };
	await authority.validate(origin);
	assert.deepEqual(originCommand(origin, "tmux", ["list-panes"]).args, ["-S", socketPath, "list-panes"]);
	assert.ok(originCommand(origin, "tmux", []).executable.startsWith("/"));
	await assert.rejects(authority.validate({ ...origin, birth: "old" }), /replaced/);
	uid = Number(uid) + 1; await assert.rejects(authority.validate(origin), /replaced/); uid = process.getuid?.();
	epoch = "new"; await assert.rejects(authority.validate(origin), error => error.status === 425); epoch = "epoch";
	rosterPid++; await assert.rejects(authority.validate(origin), /replaced/); rosterPid = pid;
	connected = false; await assert.rejects(authority.validate(origin), error => error.status === 503); connected = true;
	await assert.rejects(authority.validate({ ...origin, tmuxSocket: join(root, "missing.sock") }), /socket/);
	await assert.rejects(authority.validate(origin, randomUUID()), /gate/);
	const decisions: string[] = [];
	const ticket = broker.request({ id: "pi", pid }, { cwd: "/work", title: "Harmless preview", description: "No tool executes" }, d => decisions.push(d)); await ticket.ready;
	await authority.validate(origin, ticket.id);
	// A fresh roster registration is not the creation time of the still-live gate.
	rosterStartedAt = Date.now() + 60000; origin.broker.startedAt = rosterStartedAt;
	await authority.validate(origin, ticket.id);
	await authority.action(origin, ticket.id, "show");
	assert.equal(decisions.length, 0);
	assert.equal(focused[0].pid, pid); assert.notEqual(focused[0].pid, process.pid);
	assert.equal(focused[0].tmuxSocket, socketPath);
	assert.ok(calls.filter(c => c.args.includes("list-panes")).every(c => c.args[0] === "-S" && c.args[1] === socketPath));
	await authority.action(origin, ticket.id, "accept"); assert.deepEqual(decisions, ["once"]);
	await assert.rejects(authority.action(origin, ticket.id, "accept"), /gate/);
	born = "reused"; await assert.rejects(authority.action(origin, undefined, "show"), /replaced/);
});

for (const action of ["accept", "reject"] as const) {
	for (const revocation of ["current", "signal", "both", "in-flight"] as const) {
		test(`origin ${action} forwarding fences ${revocation} revocation across real manifest I/O`, async (t) => {
			const directory = await mkdtemp("/tmp/pi-notice-decision-fence-");
			t.after(() => rm(directory, { recursive: true, force: true }));
			const origin = {
				pid: 4321, birth: "birth", session: "sdk", generation: randomUUID(),
				sequence: "1", bindingSequence: "1",
				broker: { id: "pi", startedAt: 1, endpointEpoch: "epoch" },
			};
			const requestId = randomUUID();
			const token = "a".repeat(64);
			const key = createHash("sha256").update(JSON.stringify(["pi", origin.pid])).digest("hex");
			await writeFile(join(directory, `${key}.json`), JSON.stringify({
				version: 1, id: "pi", pid: origin.pid, updatedAt: Date.now(),
				origin: "http://127.0.0.1:12345", token, pending: [{ id: requestId, title: "Preview" }],
			}));
			const controller = new AbortController();
			let current = true, checks = 0, inspections = 0, decisions = 0;
			t.mock.method(globalThis, "fetch", async (url, init) => {
				assert.equal(init.headers.Authorization, `Bearer ${token}`);
				assert.equal(JSON.parse(init.body).requestId, requestId);
				if (String(url).endsWith("/inspect")) {
					inspections++;
					return Response.json({ permission: { id: requestId } });
				}
				assert.ok(String(url).endsWith("/decision"));
				decisions++;
				assert.equal(JSON.parse(init.body).decision, action === "accept" ? "once" : "reject");
				assert.equal(init.signal.aborted, false);
				assert.notEqual(init.signal, controller.signal, "caller cancellation is combined with the forwarding timeout");
				controller.abort();
				assert.equal(init.signal.aborted, true, "in-flight fetch receives caller cancellation");
				throw init.signal.reason;
			});
			const authority = notificationOriginAuthority({
				snapshot: () => ({ connected: true, sessions: [] }), subscribe: () => () => {},
				resolveSession: async () => ({ ...origin.broker, pid: origin.pid }) as any,
			}, directory, {
				run: async (_command, args) => args.includes("lstart=") ? origin.birth : String(process.getuid?.()),
				focus: async () => { assert.fail("decision must not focus"); },
			});
			await assert.rejects(authority.action(origin, requestId, action, () => {
				checks++;
				if (checks === 1 && revocation !== "in-flight") queueMicrotask(() => {
					// The first authority check passes, then forwarding awaits the real manifest read.
					if (revocation !== "signal") current = false;
					if (revocation !== "current") controller.abort();
				});
				return current;
			}, controller.signal), (error: any) => error.status === (revocation === "in-flight" ? 503 : 409));
			assert.equal(inspections, 1);
			assert.equal(checks, 2, "forwarding rechecks after manifest I/O");
			assert.equal(decisions, revocation === "in-flight" ? 1 : 0);
		});
	}
}

test("runtime liveness requires confirmed process death/replacement, never broker/gate/tmux or malformed probes", async (t) => {
	const birth = "Mon Sep 21 12:00:00 2026";
	const origin = {
		pid: 4321, birth, session: "sdk", generation: randomUUID(), sequence: "1", bindingSequence: "1",
		broker: { id: "pi", startedAt: 1, endpointEpoch: "old" }, tmuxSocket: "/missing.sock",
	};
	let killError: string | undefined, probeError = false, observedBirth = birth, uid = String(process.getuid?.());
	t.mock.method(process, "kill", (pid, signal) => {
		assert.equal(pid, origin.pid);
		assert.equal(signal, 0);
		if (killError) throw Object.assign(new Error("probe"), { code: killError });
		return true;
	});
	const authority = notificationOriginAuthority({
		snapshot: () => { assert.fail("liveness must not depend on broker"); },
		subscribe: () => () => {}, resolveSession: async () => { assert.fail("liveness must not inspect gates"); },
	}, "/missing-permissions", {
		run: async (_command, args) => {
			if (probeError) throw new Error("temporary ps failure");
			return args.includes("lstart=") ? observedBirth : uid;
		},
		focus: async () => { assert.fail("liveness cannot focus"); },
	});
	assert.equal(await authority.runtimeLiveness(origin), "live");
	killError = "ESRCH";
	assert.equal(await authority.runtimeLiveness(origin), "dead");
	for (const code of ["EPERM", "EIO"]) {
		killError = code;
		assert.equal(await authority.runtimeLiveness(origin), "unknown");
	}
	killError = undefined;
	probeError = true;
	assert.equal(await authority.runtimeLiveness(origin), "unknown");
	probeError = false;
	for (const invalid of ["", "nonsense", "1"]) {
		observedBirth = invalid;
		assert.equal(await authority.runtimeLiveness(origin), "unknown");
	}
	observedBirth = birth;
	for (const invalid of ["", "nonsense", "-1", "9007199254740992"]) {
		uid = invalid;
		assert.equal(await authority.runtimeLiveness(origin), "unknown");
	}
	uid = String(Number(process.getuid?.()) + 1);
	assert.equal(await authority.runtimeLiveness(origin), "dead");
	uid = String(process.getuid?.());
	observedBirth = "Tue Sep 22 12:00:00 2026";
	assert.equal(await authority.runtimeLiveness(origin), "dead");
});
