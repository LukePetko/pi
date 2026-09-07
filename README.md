# Lukas' Pi Setup

Personal Pi agent configuration with a custom terminal UI, Neovim/tmux bridge, context-mode controls, Codex usage display, and workflow helpers.

## Requirements

- macOS
- Pi installed and available as `pi`
- Node.js 22+
- Bun
- tmux
- Neovim
- zsh
- Git
- `chafa` for landing images
- `ffmpeg` for WebP landing image preprocessing
- `lazygit` for `/lazygit`
- `terminal-notifier` for macOS task-complete notifications with custom icons
- `osascript` fallback for macOS notifications, included with macOS

Recommended installs:

```bash
brew install chafa ffmpeg lazygit tmux neovim terminal-notifier
npm install -g context-mode
pi install npm:context-mode
```

## Pi packages

Configured in `agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-mermaid",
    "npm:pi-mcp-adapter",
    "npm:pi-web-access",
    "npm:pi-lens",
    "npm:context-mode"
  ]
}
```

Default model config:

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.5",
  "defaultThinkingLevel": "low",
  "theme": "lukas-purple"
}
```

## Basic setup

1. Clone/sync this config into:

```bash
~/.pi
```

2. Install runtime dependencies:

```bash
brew install chafa ffmpeg lazygit tmux neovim terminal-notifier
npm install -g context-mode
pi install npm:context-mode
```

3. Ensure Neovim loads the bridge setup:

```lua
require("pi_bridge").setup()
```

Current files live at:

```text
~/.config/nvim/lua/pi_bridge.lua
~/.config/nvim/lua/pi_bridge_setup.lua
```

4. Start Pi from inside tmux:

```bash
cd your-project
pi
```

5. Reload Pi after config changes:

```text
/reload
```

6. Reload Neovim bridge after editing it:

```vim
:luafile ~/.config/nvim/lua/pi_bridge.lua
:PiBridgeDisconnect
:PiBridgeConnect
```

## Extensions

### UI

- `status-line.ts` — custom footer/status line with model, thinking, tokens, context, cost, cwd, and elapsed task time.
- `popup.ts` — `Ctrl+B` toggled status popup with model, usage, Codex limits, context-mode, MCP, project, and git status.
- `confirm-dialog.ts` — OpenCode-style permission prompt with allow-once, session approval, and reject actions.
- `landing.ts` — startup header with rotating image art from `agent/landing/` rendered through `chafa`.
- `macos-notify.ts` — native macOS notification when an agent task completes.
- `whimsical.ts` — random working messages, including anime-flavored ones.

### Neovim/tmux

- `nvim-bridge.ts` — localhost broker on `127.0.0.1:47631` for Neovim ↔ Pi context, multiple Pi sessions, target selection, and tmux focus.
- `nvim-inspect.ts` — open files/changed files in an existing Neovim tmux pane.
- `diff.ts` — inspect changed files and open diffs/files in Neovim.
- `lib/nvim.ts` — shared tmux/Neovim helper functions.
- `subagent-tmux.ts` / `lib/subagent-tmux.ts` — display running background subagents in tmux window `9:subagents`.

Useful Neovim commands:

```vim
:PiSelect          " pick target Pi session with Telescope if available
:PiSessions        " list known Pi sessions
:PiAuto            " reset routing to automatic cwd match
:PiFocus           " focus selected Pi tmux pane
:PiSubagents       " focus tmux window 9 with running subagent panes
:PiSendSelection   " send current selection/context to Pi
:PiSendBuffer      " send buffer to Pi
:PiAsk             " ask Pi with current selection/buffer context
```

Useful Pi commands:

```text
/nvim focus       focus connected Neovim pane
/nvim subagents   focus tmux window 9 with running subagent panes
/nvim sessions    list registered Pi sessions
/nvim pull        pull current Neovim context
/nvim             send latest Neovim context into the chat
```

Shared tmux switch key:

```text
Ctrl+\
```

- In Neovim: focuses selected Pi pane.
- In Pi: focuses connected Neovim pane.

Subagent pane workflow:

```text
/subagent-panes show    rebuild tmux window 9 from currently running async subagents
/subagent-panes watch   keep window 9 refreshed while background subagents start/finish
/subagent-panes stop    stop the refresh watcher
/subagent-panes close   close 9:subagents if it exists
```

The panes tail pi-subagents async/background output logs. They are live log panes, not separate interactive child Pi TUI sessions. Use `:PiSubagents` from Neovim or `/nvim subagents` from Pi to focus the window.

### Workflow helpers

- `copy-all.ts` — `/copy-all` copies all user/assistant messages in the thread to clipboard.
- `update.ts` — `/update` updates Pi using detected install method.
- `git-interceptor.ts` — prevents git editor hangs and blocks `--no-verify`.
- `lazygit.ts` — `/lazygit` opens lazygit while temporarily suspending the Pi TUI.
- `zsh-bang.ts` — runs `!` commands through zsh with aliases.
- `ctx-mode.ts` — `/ctxmode off|light|strict`, `/ctxstats`, `/ctx-savings`, `/ctxclear`.
- `personal-kb-memory.ts` — Hermes-inspired bounded memory injection from `~/.pi-knowledge/USER.md`, `MEMORY.md`, and matching project context.
- `personal-kb-review.ts` — `/memory-review` proposes durable memory candidates; `/memory-capture text` saves approved text to KB inbox.

## Confirm dialog

`confirm-dialog.ts` asks before pushes from another repository, writes outside the active project, and configurable destructive shell commands. Configure each rule as `allow`, `ask`, or `deny` in:

```text
agent/confirm-dialog.json
```

`Allow always` is scoped to matching operations for the current Pi session. Run `/confirm-dialog` to see status, config path, and active approvals, or `/confirm-dialog test` to preview the UI. Config changes apply to the next tool call.

## Personal KB memory

Global KB:

```text
~/.pi-knowledge
```

Hermes-inspired core memory files:

```text
~/.pi-knowledge/USER.md
~/.pi-knowledge/MEMORY.md
```

`personal-kb-memory.ts` automatically injects these bounded files into the system prompt, plus matching project context when available:

```text
~/.pi-knowledge/projects/<project>/context.md
```

Memory writes are manual/review-first:

```text
/memory-review          ask Pi to propose stable memory candidates from session
/memory-capture <text>  save approved text to ~/.pi-knowledge/inbox/
```

Use the `personal-kb` skill for richer reading/searching/updating of the KB.

## Context mode

Default mode is `light`.

Commands:

```text
/ctxmode
/ctxmode off
/ctxmode light
/ctxmode strict
/ctxstats
/ctx-savings
/ctxclear
```

Context-mode state is local and ignored by git:

```text
agent/ctx-mode.json
```

## Landing images

Landing images are loaded from:

```text
~/.pi/agent/landing/
```

Supported formats:

```text
.png .jpg .jpeg .webp .gif
```

Rendered cache goes to:

```text
~/.pi/agent/cache/
```

Both are ignored by git.

Regenerate/shuffle landing art:

```text
/landing regen
```

Hide landing header:

```text
/landing hide
```

## Theme

Custom theme:

```text
agent/themes/lukas-purple.json
```

Selected in `agent/settings.json` as:

```json
"theme": "lukas-purple"
```

It makes startup section headings and accent UI purple.

## Keybindings

`agent/keybindings.json` removes Pi's default `Ctrl+B` cursor-left binding so the popup can use `Ctrl+B`:

```json
{
  "tui.editor.cursorLeft": ["left"]
}
```

Current custom shortcuts:

```text
Ctrl+B   toggle popup
Ctrl+\   switch between Pi and Neovim tmux panes
```

## Notifications

`macos-notify.ts` uses `terminal-notifier` and creates a small local `Pi Notifier.app` with a custom π app icon. Notifications also use a random image from `agent/landing/` as the content image.

Notification format:

```text
Title: anime-style completion phrase
Body:  cwd/project name · elapsed time
```

Example:

```text
Frieren finished the quest
.pi · 42s
```

If `terminal-notifier` fails, it falls back to `osascript` without a custom icon.

Test:

```text
/notify-test
```

If notifications do not appear, enable notifications for your terminal app / terminal-notifier in macOS System Settings.

## Git hygiene

Ignored local/generated paths include:

```text
agent/auth.json
agent/sessions/
agent/cache/
agent/landing/
agent/ctx-mode.json
agent/mcp-cache.json
agent/mcp-onboarding.json
agent/mcp-oauth/
.pi-lens/
context-mode/
node_modules/
```

## Troubleshooting

### Bridge says address already in use

Only one broker should listen on:

```text
127.0.0.1:47631
```

Other Pi sessions should register as clients. If stale state appears:

```vim
:PiBridgeDisconnect
:PiBridgeConnect
```

or restart Pi sessions.

### Neovim target list has stale sessions

Run:

```text
/reload
```

then:

```vim
:PiBridgeDisconnect
:PiBridgeConnect
:PiSessions
```

### `Ctrl+\` does not switch panes

Make sure both Pi and Neovim are inside tmux and the bridge was reconnected after reload:

```vim
:PiBridgeDisconnect
:PiBridgeConnect
:PiSelect
:PiFocus
```

### Landing image does not render

Check:

```bash
command -v chafa
command -v ffmpeg
```

Then regenerate:

```text
/landing regen
```
