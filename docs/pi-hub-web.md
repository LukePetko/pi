# Local web Hub (v0)

Run `/reload` once to discover the new extension, then:

- `/hub-web` — start or reuse the local dashboard server and open the default browser.
- `/hub-web stop` — stop the dashboard server, including its open browser connections.
- `/hub` / `Ctrl+H` — the existing terminal Hub, unchanged.

The web dashboard shows live Intercom-connected sessions, activity, model, project,
and context usage. Filter by name, project, model, or status. **Focus terminal** uses
our existing macOS AeroSpace/tmux navigation; detached/headless sessions may not
have a focusable window. It does not send messages, run agent turns, reload Pi,
read transcripts, or expose arbitrary command execution.

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
- Every API requires a random bearer token. Focus and stop also require the exact
  Origin. Focus accepts a session ID and resolves its PID from a fresh broker list;
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
- `agent/extensions/lib/pi-hub-web-server.ts`: authenticated HTTP/SSE adapter.
- `agent/extensions/lib/pi-hub-web/`: bundled HTML, CSS, and browser JavaScript.

No new dependencies or frontend build step. The runtime uses Node and the `tsx`
loader already installed with Intercom.

## Checks

```sh
node --experimental-strip-types --test agent/tests/pi-hub-web-*.test.js
```

The integration test uses a short `/tmp` directory to stay below macOS Unix-socket
path limits, starts an isolated broker, and checks concurrent startup, presence,
broker reconnection, stop, and stale-endpoint recovery.

The browser test uses a separate headless Chrome profile, never your normal one.
On macOS it discovers the standard Google Chrome installation. Elsewhere set
`PI_HUB_CHROME` to a Chrome/Chromium executable; the test skips if none exists.
Set `PI_HUB_SCREENSHOT=/tmp/pi-hub-web.png` to capture its fixture dashboard.
