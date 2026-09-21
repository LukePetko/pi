# Local web Hub (v2, Phase 1)

Run `/reload` once to discover the new extension, then:

- `/hub-web` — start or reuse the local dashboard server and open the default browser.
- `/hub-web stop` — stop the dashboard server, including its open browser connections.
- `/hub` / `Ctrl+H` — the existing terminal Hub, unchanged.

The web dashboard shows live Intercom-connected sessions, activity, model, project,
and context usage. Filter by name, project, model, or status. **Focus terminal** uses
our existing macOS AeroSpace/tmux navigation; detached/headless sessions may not
have a focusable window. It does not send messages, run agent turns, reload Pi,
read transcripts, or expose arbitrary command execution.

The board groups sessions into **Needs you**, **Ready for review**, **Working**,
and **Parked**. Ordinary changes are frozen until the default 25-minute check-in,
a manual refresh, or a card action; **Live updates** opts into immediate updates.
A newly identified high-risk gate breaks through for that session only. **Accept**
acknowledges a returned result and parks it, with acknowledgements saved across Hub
restarts. Status/question detection is approximate in Phase 1 and uses existing
presence/todos, not new producer signals. The terminal Hub is unchanged.

See [Phase 1 scope, adaptations and acceptance evidence](hub-web-v2-phase1.md)
and the [v2 specification](hub-web-v2-spec.md).

## Lifecycle

One detached Node process serves the dashboard for each agent directory and
`PI_INTERCOM_SCOPE_ID`. Launches are serialized with a short-lived filesystem lock.
The bridge listens on a random `127.0.0.1` port; authenticated discovery lets other
Pi instances reuse it. It survives the launching Pi instance exiting or reloading.

The bridge closes **five minutes after the last browser stream disconnects**, or
five minutes after startup if no browser connects. It uses one Intercom connection
regardless of the number of browser tabs. Intercom itself auto-starts when needed
and auto-exits after its last client disconnects. A stopped/restarted broker is
reconnected automatically.

Only sessions in the launching Pi's Intercom scope appear. The bridge hides itself
in the web dashboard, but other Intercom clients can see a helper entry named
`Pi Hub web (dashboard)` while it runs. That entry is not an agent.

Updating these files does not hot-reload an already-running bridge. After a config
update, reload Pi and run `/hub-web stop`, then `/hub-web` to start the new code.

## Local security boundary

- Loopback binding, exact Host/Origin checks, no CORS, and a restrictive CSP.
- Every API requires a random bearer token. All POST endpoints require the exact
  Origin, including acknowledgements and permission decisions. Focus accepts a session ID and resolves its PID from a fresh broker list;
  the browser cannot supply a PID or command.
- The browser receives the token in a URL fragment (not an HTTP URL), saves it in
  tab-local session storage, and removes the fragment from the address bar.
- Runtime endpoint files are mode `0600` inside a mode `0700` scope directory at
  `~/.pi/agent/cache/hub-web/<scope-hash>/`. `PI_CODING_AGENT_DIR` overrides the agent
  directory. These generated files are ignored by Git.
- SSE connections, queued event bytes, request bodies, startup waits, and focus
  workers are bounded. Focus commands run in a separate worker with a deadline.

This is a same-user local tool, not a multi-user security boundary. Another process
running as your OS user can read the endpoint credentials, and broker-provided
metadata is not authentication. Do not expose the bridge through a reverse proxy,
LAN binding, tunnel, or port forward. No remote-access support is included.

## Implementation

- `agent/extensions/pi-hub-web.ts`: command and browser opening.
- `agent/extensions/lib/pi-hub-web-launcher.ts`: scoped discovery, locking, startup, stop.
- `agent/extensions/lib/pi-hub-web-main.ts`: standalone lifecycle and focus worker.
- `agent/extensions/lib/pi-hub-web-source.ts`: Intercom snapshots and reconnects.
- `agent/extensions/lib/pi-hub-web-server.ts`: authenticated HTTP/SSE adapter and acknowledgement API.
- `agent/extensions/lib/hub-attention.ts`: pure classification and atomic acknowledgement persistence.
- `agent/extensions/lib/pi-hub-web/board.ts`: ranking, check-in freeze and high-risk breakthrough.
- `agent/extensions/lib/pi-hub-web/`: bundled HTML, CSS, and browser JavaScript.

No new dependencies or frontend build step. The runtime uses Node and the `tsx`
loader already installed with Intercom.

## Checks

```sh
node --experimental-strip-types --test agent/tests/pi-hub-web-*.test.ts
```

The integration test uses a short `/tmp` directory to stay below macOS Unix-socket
path limits, starts an isolated broker, and checks concurrent startup, presence,
broker reconnection, stop, and stale-endpoint recovery.

Browser regression tests cover frozen ordering, high-risk breakthrough, card actions,
Live/check-in controls, acknowledgements, archive/filter behavior, keyed DOM/todo
state, full permission details and mobile layout.

The browser tests use a separate headless Chrome profile, never your normal one.
On macOS it discovers the standard Google Chrome installation. Elsewhere set
`PI_HUB_CHROME` to a Chrome/Chromium executable; the test skips if none exists.
Set `PI_HUB_SCREENSHOT=/tmp/pi-hub-web.png` to capture its fixture dashboard.
