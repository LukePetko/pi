import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type Pane = {
  target: string;
  pid: string;
  command: string;
  cwd: string;
};

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function getNvimPanes(): Pane[] {
  const out = run("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}",
  ]);

  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [target, pid, command, cwd] = line.split("\t");
      return { target, pid, command, cwd } as Pane;
    })
    .filter((pane) => pane.command === "nvim" || pane.command === "vim");
}

const gitRootCache = new Map<string, string | undefined>();
let lastPane: Pane | undefined;

function gitRoot(cwd: string): string | undefined {
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let root: string | undefined;
  try {
    root = run("git", ["rev-parse", "--show-toplevel"], cwd);
  } catch {
    root = undefined;
  }
  gitRootCache.set(cwd, root);
  return root;
}

function scorePane(pane: Pane, cwd: string, cwdRoot = gitRoot(cwd)): number {
  if (lastPane?.target === pane.target) return 120;
  if (pane.cwd === cwd) return 100;
  const paneRoot = gitRoot(pane.cwd);
  if (paneRoot && cwdRoot && paneRoot === cwdRoot) return 80;
  if (cwd.startsWith(pane.cwd) || pane.cwd.startsWith(cwd)) return 50;
  return 0;
}

async function pickPane(ctx: ExtensionCommandContext): Promise<Pane | undefined> {
  const cwdRoot = gitRoot(ctx.cwd);
  const panes = getNvimPanes().sort((a, b) => scorePane(b, ctx.cwd, cwdRoot) - scorePane(a, ctx.cwd, cwdRoot));
  if (panes.length === 0) {
    ctx.ui.notify("No running nvim pane found in tmux", "error");
    return undefined;
  }
  if (panes.length === 1 || !ctx.hasUI) return panes[0];

  const bestScore = scorePane(panes[0], ctx.cwd, cwdRoot);
  const tied = panes.filter((pane) => scorePane(pane, ctx.cwd, cwdRoot) === bestScore);
  if (tied.length === 1 && bestScore > 0) return tied[0];

  const choice = await ctx.ui.select(
    "Open in which nvim?",
    panes.map((pane) => ({
      label: `${pane.target}  ${pane.cwd}`,
      value: pane.target,
    })),
  );
  return panes.find((pane) => pane.target === choice);
}

function vimEscape(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/ /g, "\\ ").replace(/\|/g, "\\|").replace(/%/g, "\\%");
}

function sendToNvim(pane: Pane, files: string[]): void {
  if (files.length === 0) return;
  lastPane = pane;
  const escaped = files.map(vimEscape);
  const cmd = `:args ${escaped.join(" ")} | edit ${escaped[0]}`;
  execFileSync("tmux", [
    "send-keys", "-t", pane.target, "Escape", ";",
    "send-keys", "-t", pane.target, cmd, "Enter", ";",
    "switch-client", "-t", pane.target.split(":")[0], ";",
    "select-window", "-t", pane.target.split(".")[0], ";",
    "select-pane", "-t", pane.target,
  ]);
}

function changedFiles(cwd: string): string[] {
  const tracked = run("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"], cwd)
    .split("\n")
    .filter(Boolean);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], cwd)
    .split("\n")
    .filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked]))
    .map((file) => resolve(cwd, file))
    .filter((file) => existsSync(file));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("nvim", {
    description: "Open files in a running nvim tmux pane (usage: /nvim file1 file2)",
    handler: async (args, ctx) => {
      const files = args
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter(Boolean)
        .map((file) => resolve(ctx.cwd, file));

      if (files.length === 0) {
        ctx.ui.notify("Usage: /nvim file1 file2", "warning");
        return;
      }

      const pane = await pickPane(ctx);
      if (!pane) return;
      sendToNvim(pane, files);
      ctx.ui.notify(`Opened ${files.length} file(s) in nvim ${pane.target}`, "success");
    },
  });

  pi.registerCommand("nvim-changed", {
    description: "Open git changed files in a running nvim tmux pane",
    handler: async (_args, ctx) => {
      const files = changedFiles(ctx.cwd);
      if (files.length === 0) {
        ctx.ui.notify("No changed files found", "info");
        return;
      }
      const pane = await pickPane(ctx);
      if (!pane) return;
      sendToNvim(pane, files);
      ctx.ui.notify(`Opened ${files.length} changed file(s) in nvim ${pane.target}`, "success");
    },
  });
}
