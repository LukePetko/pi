import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	classifyToolCall,
	DEFAULT_CONFIG,
	findGitPushContexts,
	isPathOutside,
	parseConfirmDialogConfig,
} from "../extensions/lib/confirm-dialog.ts";

const cwd = "/work/project";
const roots = (path: string) =>
	path.includes("/other") ? "/work/other" : "/work/project";

describe("confirm dialog rules", () => {
	test("allows a normal push in the active repository", () => {
		assert.equal(
			classifyToolCall({
				toolName: "bash",
				input: { command: "git push" },
				cwd,
				config: DEFAULT_CONFIG,
				gitRoot: roots,
			}),
			undefined,
		);
	});

	test("asks before git -C pushes to another repository", () => {
		const match = classifyToolCall({
			toolName: "bash",
			input: { command: "git -C ../other push origin main" },
			cwd,
			config: DEFAULT_CONFIG,
			gitRoot: roots,
		});
		assert.equal(match?.id, "git-push-outside-project");
		assert.equal(
			match?.approvalKey,
			"git-push-outside-project:/work/other",
		);
	});

	test("asks before a push after changing directories", () => {
		for (const command of [
			"cd ../other && git push",
			"pushd ../other && git push",
			"env -C ../other git push",
		]) {
			const match = classifyToolCall({
				toolName: "bash",
				input: { command },
				cwd,
				config: DEFAULT_CONFIG,
				gitRoot: roots,
			});
			assert.equal(match?.id, "git-push-outside-project");
		}
	});

	test("treats unresolved directory expressions as external", () => {
		const contexts = findGitPushContexts('cd "$OTHER_REPO" && git push', cwd);
		assert.deepEqual(contexts, [
			{ directory: undefined, explicitContext: true },
		]);
	});

	test("asks before recursive deletion and destructive pushes", () => {
		for (const command of [
			"rm -rf build",
			"git push --force origin main",
			"git push -f origin main",
			"git push --delete origin old-branch",
		]) {
			const match = classifyToolCall({
				toolName: "bash",
				input: { command },
				cwd,
				config: DEFAULT_CONFIG,
				gitRoot: roots,
			});
			assert.equal(match?.id, command.startsWith("rm") ? "recursive-delete" : "destructive-git");
		}
	});

	test("prioritizes destructive protection over an external-repository approval", () => {
		const match = classifyToolCall({
			toolName: "bash",
			input: { command: "git -C ../other push --force origin main" },
			cwd,
			config: DEFAULT_CONFIG,
			gitRoot: roots,
		});
		assert.equal(match?.id, "destructive-git");
	});

	test("asks before writing outside the active project", () => {
		const match = classifyToolCall({
			toolName: "functions.edit",
			input: { path: "../other/config.ts" },
			cwd,
			config: DEFAULT_CONFIG,
			gitRoot: roots,
		});
		assert.equal(match?.id, "write-outside-project");
	});

	test("recognizes paths inside and outside a boundary", () => {
		assert.equal(isPathOutside("/work/project/src/a.ts", cwd), false);
		assert.equal(isPathOutside("/work/other/a.ts", cwd), true);
	});

	test("supports allow, ask, deny, and custom bash patterns", () => {
		const config = parseConfirmDialogConfig({
			enabled: true,
			permissions: {
				gitPushOutsideProject: "deny",
				writeOutsideProject: "allow",
			},
			destructiveBash: [
				{
					id: "production-deploy",
					action: "ask",
					pattern: "deploy\\s+production",
					title: "Deploy production",
				},
			],
		});
		assert.equal(config.permissions.gitPushOutsideProject, "deny");
		assert.equal(config.permissions.writeOutsideProject, "allow");
		assert.equal(
			classifyToolCall({
				toolName: "bash",
				input: { command: "deploy production" },
				cwd,
				config,
				gitRoot: roots,
			})?.id,
			"production-deploy",
		);
	});
});
