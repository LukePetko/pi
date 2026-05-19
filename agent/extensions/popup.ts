import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Component, OverlayHandle } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const PANEL_WIDTH = 68;
const PANEL_MIN_TERMINAL_WIDTH = 80;

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let handle: OverlayHandle | null = null;
  let activeTui: { requestRender: () => void } | null = null;

  function show(ctx: ExtensionContext): void {
    if (!enabled || handle) return;

    void ctx.ui.custom<void>((tui, theme, _keybindings, _done) => {
      activeTui = tui;
      return new FloatingPanel(tui, theme, ctx, pi);
    }, {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: PANEL_WIDTH,
        nonCapturing: true,
        visible: (termWidth) => termWidth >= PANEL_MIN_TERMINAL_WIDTH,
      },
      onHandle: (overlayHandle) => {
        handle = overlayHandle;
      },
    }).finally(() => {
      handle = null;
      activeTui = null;
    });
  }

  function hide(): void {
    const h = handle;
    handle = null;
    activeTui = null;
    h?.hide();
  }

  pi.on("session_start", async (_event, ctx) => {
    if (enabled) show(ctx);
  });
  pi.on("thinking_level_select", async () => {
    activeTui?.requestRender();
  });
  pi.on("model_select", async () => {
    activeTui?.requestRender();
  });
  pi.on("session_shutdown", async () => hide());

  function toggle(ctx: ExtensionContext): void {
    enabled = !enabled;
    if (enabled) show(ctx);
    else hide();
  }

  pi.registerCommand("popup", {
    description: "Toggle the popup status panel",
    handler: async (_args, ctx) => toggle(ctx),
  });

  pi.registerShortcut("ctrl+b", {
    description: "Toggle the popup status panel",
    handler: async (ctx) => toggle(ctx),
  });
}

class FloatingPanel implements Component {
  constructor(
    private tui: any,
    private theme: any,
    private ctx: ExtensionContext,
    private pi: ExtensionAPI,
  ) {}

  private rgb(hex: string, text: string): string {
    const clean = hex.replace("#", "");
    const r = Number.parseInt(clean.slice(0, 2), 16);
    const g = Number.parseInt(clean.slice(2, 4), 16);
    const b = Number.parseInt(clean.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }

  private gray(text: string): string {
    return this.rgb("#a1a1aa", text);
  }

  private pad(content: string, width: number): string {
    const truncated = truncateToWidth(content, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private n(value: number, digits = 1): string {
    if (!Number.isFinite(value)) return "0";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(digits)}M`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(digits)}k`;
    return abs >= 100 ? value.toFixed(0) : value.toFixed(digits);
  }

  private money(value: number): string {
    return `$${value >= 1 ? value.toFixed(2) : value.toFixed(3)}`;
  }

  private sessionTotals() {
    const totals = { input: 0, output: 0, cost: 0, usingSubscription: false };
    const model = (this.ctx as any).model;
    totals.usingSubscription = !!(model && (this.ctx as any).modelRegistry?.isUsingOAuth?.(model));

    for (const entry of this.ctx.sessionManager.getBranch() as any[]) {
      const msg = entry?.message;
      if (msg?.role !== "assistant" || !msg.usage) continue;
      totals.input += msg.usage.input ?? 0;
      totals.output += msg.usage.output ?? 0;
      totals.cost += msg.usage.cost?.total ?? 0;
    }
    return totals;
  }

  private title(): string {
    const explicit = (this.ctx.sessionManager as any).getSessionName?.();
    if (explicit) return explicit;

    for (const entry of this.ctx.sessionManager.getBranch() as any[]) {
      const msg = entry?.message;
      if (msg?.role !== "user") continue;
      const content = msg.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join(" ")
          : "";
      const cleaned = text.replace(/\s+/g, " ").trim();
      if (cleaned) return cleaned;
    }

    return "Untitled chat";
  }

  render(width: number): string[] {
    const padX = 5;
    const innerWidth = Math.max(1, width - 2 - padX * 2);
    const border = (s: string) => this.rgb("#7c3aed", this.theme.bold(s));
    const row = (content = "") => `${border("│")}${" ".repeat(padX)}${this.pad(content, innerWidth)}${" ".repeat(padX)}${border("│")}`;

    const title = this.title();
    const activeModel = (this.ctx as any).model;
    const modelName = activeModel?.name ?? activeModel?.id ?? "model";
    const model = this.rgb("#c084fc", modelName);
    const thinking = this.rgb("#7dd3fc", this.pi.getThinkingLevel());
    const totals = this.sessionTotals();
    const context = this.ctx.getContextUsage();
    const contextText = context
      ? `${context.tokens == null ? "?" : this.n(context.tokens)}/${context.contextWindow == null ? "?" : this.n(context.contextWindow)} (${context.percent == null ? "?" : this.n(context.percent)}%)`
      : "?/? (?)";
    const priceText = `${this.money(totals.cost)}${totals.usingSubscription ? " (sub)" : ""}`;

    return [
      `${border("╭")}${border("─".repeat(innerWidth + padX * 2))}${border("╮")}`,
      row(),
      row(this.theme.bold(title)),
      row(),
      row(this.theme.bold("Model")),
      row(`Name        ${model}`),
      row(`Thinking    ${thinking}`),
      row(),
      row(this.theme.bold("Usage")),
      row(`Input       ${this.gray(`${this.n(totals.input, 0)} tokens`)}`),
      row(`Output      ${this.gray(`${this.n(totals.output)} tokens`)}`),
      row(`Price       ${this.rgb("#fb923c", priceText)}`),
      row(`Context     ${this.gray(contextText)}`),
      row(),
      row(this.theme.bold("MCP")),
      row(`${this.rgb("#86efac", "•")} Atlassian ${this.gray("Connected")}`),
      row(),
      row(),
      `${border("╰")}${border("─".repeat(innerWidth + padX * 2))}${border("╯")}`,
    ];
  }

  invalidate(): void {
    this.tui?.requestRender?.();
  }
  dispose(): void {}
}
