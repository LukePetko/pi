import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openFilesInNvim, run } from "./lib/nvim";

const commandName = "diff";

function getStringPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("path" in input)) return undefined;
  return typeof input.path === "string" ? input.path : undefined;
}

function toAbsolute(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? normalize(filePath) : resolve(cwd, filePath);
}

function toRelative(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : filePath;
}

function parseGitStatus(output: string, cwd: string): Set<string> {
  const files = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const targetPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
    if (targetPath) files.add(toAbsolute(cwd, targetPath.replace(/^"|"$/g, "")));
  }
  return files;
}

async function getGitChangedFiles(pi: ExtensionAPI, cwd: string): Promise<Set<string>> {
  const result = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeout: 5000 });
  if (result.code !== 0) return new Set();
  return parseGitStatus(result.stdout, cwd);
}

function difference(current: Set<string>, baseline: Set<string>): Set<string> {
  return new Set([...current].filter((file) => !baseline.has(file)));
}

function changedFilesFromGit(cwd: string): string[] {
  const tracked = run("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"], cwd).split("\n").filter(Boolean);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked])).map((file) => resolve(cwd, file)).filter((file) => existsSync(file));
}

function lineStats(cwd: string, file: string): string {
  const rel = toRelative(cwd, file);
  try {
    const out = run("git", ["diff", "--numstat", "HEAD", "--", rel], cwd);
    const first = out.split("\n").find(Boolean);
    if (first) {
      const [added, removed] = first.split("\t");
      if (added === "-" || removed === "-") return "binary";
      return `+${added ?? 0}/-${removed ?? 0}`;
    }
  } catch {}

  try {
    const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--", rel], cwd);
    if (untracked.trim()) {
      const content = execFileSync("wc", ["-l", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const lines = Number(content.split(/\s+/)[0] ?? 0);
      return `+${lines}/-0`;
    }
  } catch {}

  return "+0/-0";
}

export default function (pi: ExtensionAPI) {
  let gitBaseline = new Set<string>();
  let changedFiles = new Set<string>();
  let toolTouchedFiles = new Set<string>();

  pi.on("agent_start", async (_event, ctx) => {
    toolTouchedFiles = new Set();
    changedFiles = new Set();
    gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const filePath = getStringPath(event.input);
    if (filePath) toolTouchedFiles.add(toAbsolute(ctx.cwd, filePath));
  });

  pi.on("agent_end", async (_event, ctx) => {
    const gitChanged = await getGitChangedFiles(pi, ctx.cwd);
    changedFiles = new Set([...difference(gitChanged, gitBaseline), ...toolTouchedFiles]);
    if (changedFiles.size > 0) ctx.ui.notify(`${changedFiles.size} changed file(s). Run /${commandName} to inspect in nvim.`, "info");
  });

  pi.registerCommand(commandName, {
    description: "Show files changed by the last agent run and open one in nvim",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const arg = args.trim();

      if (arg === "clear") {
        changedFiles = new Set();
        toolTouchedFiles = new Set();
        gitBaseline = await getGitChangedFiles(pi, ctx.cwd);
        return ctx.ui.notify("Cleared changed file list", "info");
      }

      const useGitChanges = arg === "git" || arg === "git list";
      const files = (useGitChanges ? changedFilesFromGit(ctx.cwd) : [...changedFiles].filter(existsSync))
        .sort((a, b) => toRelative(ctx.cwd, a).localeCompare(toRelative(ctx.cwd, b)));
      if (files.length === 0) return ctx.ui.notify(useGitChanges ? "No git changed files found" : "No changed files tracked from the last agent run", "info");

      if (arg === "list" || arg === "git list") {
        return ctx.ui.notify(`Changed files:\n${files.map((file) => `- ${toRelative(ctx.cwd, file)}  ${lineStats(ctx.cwd, file)}`).join("\n")}`, "info");
      }
      if (arg && arg !== "git") return ctx.ui.notify(`Unknown /${commandName} argument: ${arg}. Try /${commandName}, /${commandName} git, /${commandName} list, /${commandName} git list, or /${commandName} clear.`, "warning");

      const labels = files.map((file) => `${toRelative(ctx.cwd, file)}  ${lineStats(ctx.cwd, file)}`);
      const selected = await ctx.ui.select("Open changed file in nvim", labels);
      if (!selected) return;
      const file = files[labels.indexOf(selected)];
      if (!file) return;
      await openFilesInNvim(ctx, [file]);
    },
  });
}
