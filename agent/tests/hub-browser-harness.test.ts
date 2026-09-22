import assert from "node:assert/strict";
import { test } from "node:test";
import { chromeDevToolsAddress } from "./lib/hub-browser.ts";

const path = "/devtools/browser/01234567-89ab-cdef-0123-456789abcdef";

test("Chrome startup parser waits for a complete bounded port and browser UUID", () => {
	for (const contents of ["", "\n", "9222", "9222\n", "9222\n/devtools/browser/", `9222\n${path.slice(0, -1)}`,
		`0\n${path}`, `65536\n${path}`, `-1\n${path}`, `1.5\n${path}`, `abc\n${path}`, `9e3\n${path}`,
		`9222\n/devtools/page/01234567-89ab-cdef-0123-456789abcdef`, `9222\n${path}?query`, `9222\n${path}\nextra`]) {
		assert.equal(chromeDevToolsAddress(contents), undefined, JSON.stringify(contents));
	}
	for (const port of [1, 9222, 65535]) {
		assert.equal(chromeDevToolsAddress(`${port}\n${path}\n`), `ws://127.0.0.1:${port}${path}`);
	}
	assert.equal(chromeDevToolsAddress(`9222\r\n${path}\r\n`), `ws://127.0.0.1:9222${path}`);
});
