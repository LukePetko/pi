import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type RuleAction = "allow" | "ask" | "deny";

export type DestructiveBashRule = {
	id: string;
	action: RuleAction;
	pattern: string;
	title: string;
};

export type ConfirmDialogConfig = {
	enabled: boolean;
	permissions: {
		gitPushOutsideProject: RuleAction;
		writeOutsideProject: RuleAction;
	};
	destructiveBash: DestructiveBashRule[];
};

export type PermissionMatch = {
	id: string;
	action: RuleAction;
	title: string;
	description: string;
	approvalKey: string;
};

type GitPushContext = {
	directory?: string;
	explicitContext: boolean;
};

type ClassifyOptions = {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	config: ConfirmDialogConfig;
	gitRoot?: (cwd: string) => string | undefined;
};

const ACTIONS = new Set<RuleAction>(["allow", "ask", "deny"]);
const SHELL_TOKEN = String.raw`("(?:\\.|[^"])*"|'[^']*'|[^\s;&|()]+)`;

export const DEFAULT_CONFIG: ConfirmDialogConfig = {
	enabled: true,
	permissions: {
		gitPushOutsideProject: "ask",
		writeOutsideProject: "ask",
	},
	destructiveBash: [
		{
			id: "recursive-delete",
			action: "ask",
			pattern: String.raw`\brm\s+[^\n]*(?:-[^\s]*[rR][^\s]*|--recursive)`,
			title: "Delete files recursively",
		},
		{
			id: "destructive-git",
			action: "ask",
			pattern: String.raw`\bgit\s+(?:[^;&|\n]*\s)?(?:reset\s+--hard|clean\s+-[^\s]*f|branch\s+-D|checkout\s+--|restore\s+[^;&|\n]*|push\s+[^;&|\n]*(?:--force(?:-with-lease)?|-f\b|--delete\b))`,
			title: "Run a destructive Git command",
		},
		{
			id: "database-destruction",
			action: "ask",
			pattern: String.raw`\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b`,
			title: "Run a destructive database command",
		},
		{
			id: "infrastructure-destruction",
			action: "ask",
			pattern: String.raw`\b(?:terraform\s+destroy|kubectl\s+delete|docker\s+(?:system|volume)\s+prune)\b`,
			title: "Destroy infrastructure or shared resources",
		},
	],
};

function parseAction(value: unknown, fallback: RuleAction): RuleAction {
	return typeof value === "string" && ACTIONS.has(value as RuleAction)
		? (value as RuleAction)
		: fallback;
}

export function parseConfirmDialogConfig(value: unknown): ConfirmDialogConfig {
	if (!value || typeof value !== "object") return structuredClone(DEFAULT_CONFIG);
	const input = value as Record<string, unknown>;
	let permissions: Record<string, unknown> = {};
	if (input.permissions && typeof input.permissions === "object") {
		permissions = input.permissions as Record<string, unknown>;
	}

	let configuredRules = structuredClone(DEFAULT_CONFIG.destructiveBash);
	if (Array.isArray(input.destructiveBash)) {
		configuredRules = input.destructiveBash
			.map((item, index): DestructiveBashRule | undefined => {
				if (!item || typeof item !== "object") return undefined;
				const rule = item as Record<string, unknown>;
				if (typeof rule.pattern !== "string" || !rule.pattern) return undefined;
				try {
					new RegExp(rule.pattern, "iu");
				} catch {
					return undefined;
				}
				const id =
					typeof rule.id === "string" && rule.id
						? rule.id
						: `custom-${index + 1}`;
				const title =
					typeof rule.title === "string" && rule.title
						? rule.title
						: "Run a protected shell command";
				return {
					id,
					action: parseAction(rule.action, "ask"),
					pattern: rule.pattern,
					title,
				};
			})
			.filter((rule): rule is DestructiveBashRule => rule !== undefined);
	}

	return {
		enabled: input.enabled !== false,
		permissions: {
			gitPushOutsideProject: parseAction(
				permissions.gitPushOutsideProject,
				DEFAULT_CONFIG.permissions.gitPushOutsideProject,
			),
			writeOutsideProject: parseAction(
				permissions.writeOutsideProject,
				DEFAULT_CONFIG.permissions.writeOutsideProject,
			),
		},
		destructiveBash: configuredRules,
	};
}

function canonicalizePath(path: string): string {
	const absolute = resolve(path);
	if (existsSync(absolute)) return realpathSync.native(absolute);

	const missing: string[] = [];
	let cursor = absolute;
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) return absolute;
		missing.unshift(relative(parent, cursor));
		cursor = parent;
	}
	return join(realpathSync.native(cursor), ...missing);
}

export function isPathOutside(path: string, boundary: string): boolean {
	const target = canonicalizePath(path);
	const root = canonicalizePath(boundary);
	const offset = relative(root, target);
	return offset === ".." || offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(offset);
}

function decodeShellPath(token: string, cwd: string): string | undefined {
	let value = token.trim();
	if (!value || /[$`*?]/u.test(value)) return undefined;
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}
	value = value.replace(/\\([\\"' ])/gu, "$1");
	if (value === "~") value = process.env.HOME ?? value;
	else if (value.startsWith("~/")) value = join(process.env.HOME ?? "~", value.slice(2));
	return resolve(cwd, value);
}

function lastDirectoryChange(prefix: string, cwd: string): GitPushContext {
	const directoryPattern = new RegExp(
		String.raw`(?:^|[;&|(\n]\s*)(?:cd|pushd)\s+${SHELL_TOKEN}\s*(?:&&|;|\n)`,
		"giu",
	);
	let directory: string | undefined;
	let found = false;
	for (const match of prefix.matchAll(directoryPattern)) {
		found = true;
		directory = decodeShellPath(match[1] ?? "", cwd);
	}
	if (found) return { directory, explicitContext: true };
	if (/\b(?:cd|pushd)\s+/u.test(prefix) || /\benv\b[^;&|\n]*\s-C(?:\s|=)/u.test(prefix)) {
		return { explicitContext: true };
	}
	return { directory: cwd, explicitContext: false };
}

export function findGitPushContexts(command: string, cwd: string): GitPushContext[] {
	const contexts: GitPushContext[] = [];
	const gitPushPattern = /\bgit\b([^;&|\n]*?)\bpush\b/giu;
	for (const match of command.matchAll(gitPushPattern)) {
		const gitIndex = match.index ?? 0;
		const cdContext = lastDirectoryChange(command.slice(0, gitIndex), cwd);
		const gitArgs = match[1] ?? "";
		const gitDirPattern = /(?:^|\s)(?:--git-dir|--work-tree)(?:=|\s+)/iu;
		if (gitDirPattern.test(gitArgs) || /\bGIT_(?:DIR|WORK_TREE)\s*=/u.test(command.slice(0, gitIndex))) {
			contexts.push({ explicitContext: true });
			continue;
		}

		const cPattern = new RegExp(String.raw`(?:^|\s)-C\s+${SHELL_TOKEN}`, "giu");
		let cToken: string | undefined;
		for (const cMatch of gitArgs.matchAll(cPattern)) cToken = cMatch[1];
		if (cToken !== undefined) {
			contexts.push({
				directory: decodeShellPath(cToken, cdContext.directory ?? cwd),
				explicitContext: true,
			});
			continue;
		}
		contexts.push(cdContext);
	}
	return contexts;
}

function normalizeToolName(toolName: string): string {
	return toolName.split(".").at(-1) ?? toolName;
}

export function classifyToolCall(options: ClassifyOptions): PermissionMatch | undefined {
	const { input, cwd, config } = options;
	if (!config.enabled) return undefined;
	const toolName = normalizeToolName(options.toolName);
	const activeRoot = options.gitRoot?.(cwd) ?? cwd;

	if (toolName === "bash" && typeof input.command === "string") {
		const command = input.command;
		for (const rule of config.destructiveBash) {
			if (!new RegExp(rule.pattern, "iu").test(command)) continue;
			if (rule.action !== "allow") {
				return {
					id: rule.id,
					action: rule.action,
					title: rule.title,
					description: `$ ${command}`,
					approvalKey: `${rule.id}:${command}`,
				};
			}
			break;
		}

		for (const context of findGitPushContexts(command, cwd)) {
			const targetRoot = context.directory
				? options.gitRoot?.(context.directory) ?? context.directory
				: undefined;
			const outside = targetRoot
				? isPathOutside(targetRoot, activeRoot)
				: context.explicitContext;
			if (outside) {
				const action = config.permissions.gitPushOutsideProject;
				if (action !== "allow") {
					const target = targetRoot ?? "an unresolved external directory";
					return {
						id: "git-push-outside-project",
						action,
						title: "Push another repository",
						description: `$ ${command}\nRepository: ${target}`,
						approvalKey: `git-push-outside-project:${target}`,
					};
				}
			}
		}
	}

	if ((toolName === "edit" || toolName === "write") && typeof input.path === "string") {
		const target = resolve(cwd, input.path);
		if (isPathOutside(target, activeRoot)) {
			const action = config.permissions.writeOutsideProject;
			if (action === "allow") return undefined;
			return {
				id: "write-outside-project",
				action,
				title: `${toolName === "edit" ? "Edit" : "Write"} outside the active project`,
				description: `Path: ${target}`,
				approvalKey: `write-outside-project:${target}`,
			};
		}
	}

	return undefined;
}
