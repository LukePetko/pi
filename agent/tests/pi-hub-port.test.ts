import assert from "node:assert/strict";
import { test } from "node:test";
import { hubPort } from "../extensions/lib/pi-hub-web-launcher.ts";
import { startHubServer } from "../extensions/lib/pi-hub-web-server.ts";

 test("resident Hub defaults to 47831 with explicit validated overrides", () => {
	assert.equal(hubPort({}), 47831);
	assert.equal(hubPort({ PI_HUB_PORT: "47832" }), 47832);
	assert.equal(hubPort({ PI_HUB_PORT: "0" }), 0);
	assert.equal(hubPort({ PI_HUB_PORT: "65535" }), 65535);
	for (const value of ["", "-1", "65536", "1.5", "0xB", "NaN", "47831x", " 47831"])
		assert.throws(() => hubPort({ PI_HUB_PORT: value }), /PI_HUB_PORT/);
});

test("Hub binds the requested port, rejects collisions, and reuses it after restart", async (t) => {
	const options = {
		token: "a".repeat(64),
		source: {
			snapshot: () => ({ connected: true, sessions: [] }),
			subscribe: () => () => {},
			resolveSession: async () => undefined,
		},
		focus: async () => {},
	};
	const first = await startHubServer({ ...options, port: 0 });
	t.after(() => first.close());
	const port = Number(new URL(first.origin).port);
	await assert.rejects(startHubServer({ ...options, port }), { code: "EADDRINUSE" });
	await first.close();
	const restarted = await startHubServer({ ...options, port });
	t.after(() => restarted.close());
	assert.equal(restarted.origin, `http://127.0.0.1:${port}`);
	const response = await fetch(`${restarted.origin}/api/health`, {
		headers: { Authorization: `Bearer ${options.token}` },
	});
	assert.equal(response.status, 200);
});
