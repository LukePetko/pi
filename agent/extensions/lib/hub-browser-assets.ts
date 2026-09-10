import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// Hub already depends on tsx. Resolve its compiler from that dependency's own
// scope, rather than requiring another global install or checked-in build output.
const require = createRequire(new URL("../../npm/node_modules/pi-intercom/package.json", import.meta.url));
const compiler = createRequire(require.resolve("tsx"))("esbuild") as typeof import("../../npm/node_modules/esbuild/lib/main.js");

/** Compile the bundled TypeScript modules once at server startup, in memory. */
export async function loadHubBrowserAsset(file: string): Promise<string> {
	const source = await readFile(new URL(`./pi-hub-web/${file}`, import.meta.url), "utf8");
	if (!file.endsWith(".ts")) return source;
	const result = await compiler.transform(source, {
		loader: "ts", format: "esm", target: "es2022", sourcefile: file,
	});
	return result.code;
}
