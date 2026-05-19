import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { openFilesInNvim, run } from "./lib/nvim";

function changedFilesFromGit(cwd: string): string[] {
  const tracked = run("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD"], cwd).split("\n").filter(Boolean);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked])).map((file) => resolve(cwd, file)).filter((file) => existsSync(file));
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("nvim", {
    description: "Open files in a running nvim tmux pane (usage: /nvim file1 file2)",
    handler: async (args, ctx) => {
      const files = args.split(/\s+/).map((arg) => arg.trim()).filter(Boolean).map((file) => resolve(ctx.cwd, file));
      if (files.length === 0) return ctx.ui.notify("Usage: /nvim file1 file2", "warning");
      await openFilesInNvim(ctx, files);
    },
  });

  pi.registerCommand("nvim-changed", {
    description: "Open all git changed files in a running nvim tmux pane",
    handler: async (_args, ctx) => {
      const files = changedFilesFromGit(ctx.cwd);
      if (files.length === 0) return ctx.ui.notify("No changed files found", "info");
      await openFilesInNvim(ctx, files);
    },
  });
}
