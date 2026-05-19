import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lazygit", {
    description: "Open lazygit",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("lazygit requires interactive TUI mode", "error");
        return;
      }

      await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
        // External TUIs need the real terminal. pi extensions can't currently embed
        // lazygit inside a true floating terminal pane, so we temporarily suspend pi,
        // run lazygit, then restore pi afterwards.
        tui.stop();
        process.stdout.write("\x1b[2J\x1b[H");

        const result = spawnSync("lazygit", [], {
          cwd: ctx.cwd,
          stdio: "inherit",
          env: process.env,
        });

        tui.start();
        tui.requestRender(true);
        done(result.status ?? 0);

        return { render: () => [], invalidate: () => {} };
      });
    },
  });
}
