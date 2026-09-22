# Local web Hub (resident service)

Run `/reload` once to discover the new extension, then:

- `/hub-web` — start or reuse the local dashboard server and open the default browser.
- `/hub-web stop` — stop the service and disable automatic startup until an explicit start/open.
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

The service is **resident**: it stays running with no browser, no Pi sessions, or
an unavailable Intercom source. It uses one Intercom connection regardless of the
number of browser tabs. Intercom itself auto-starts when needed and auto-exits
after its last client disconnects; a resident Hub remains a client. A stopped or
restarted broker is reconnected automatically. Browser-idle lifetime is retained
only as an explicit server option for compatibility tests.

### Standalone management (no running Pi required)

From this repository, using Node with TypeScript stripping support:

```sh
node --experimental-strip-types agent/hub.ts start
node --experimental-strip-types agent/hub.ts status
node --experimental-strip-types agent/hub.ts open
node --experimental-strip-types agent/hub.ts stop
```

The executable `agent/hub.ts` also works directly when Node is on PATH. Set
`PI_CODING_AGENT_DIR` and `PI_INTERCOM_SCOPE_ID` consistently to select a scope.
`start` and `open` are explicit user actions, as is `/hub-web`: they clear stopped
intent. Automatic clients using `ensureHubWeb` cannot clear it. Authenticated
`/api/stop` and CLI stop both durably save stopped intent and serialize with
launches. Launcher stop requests are revision/instance-fenced, so a delayed stop
cannot undo a later explicit start or stop a replacement process. Stop never
removes acknowledgements or other user data. A signal/crash
leaves desired intent unchanged; run `start` to recover, or a future automatic
client may restart when intent is still running.

`status` is read-only JSON: desired intent is separate from service health
(`running`, `absent`, `stale`, `incompatible`, `unhealthy-or-unverified`, or
`control-in-progress` when a live control lock precedes discovery), source
connectivity and `autostart: not-managed`. A stopped intent can coexist with an
unverified live PID; the CLI reports that condition and never kills it based on
stored metadata. Discovery authenticates instance, lifetime and capabilities,
not merely PID existence. An old incompatible service must be stopped using its
old version before upgrading; it is not silently adopted.

**No login autostart, launchd installation, automatic crash supervisor or service
uninstaller is included yet.** This is a detached resident process, not an
OS-supervised always-on service. Stop reverses activation without purging state.
Only explicit launches are needed; status and extension discovery never start it.
Lifecycle diagnostics are private and capped at 16 KiB of text in
`service.log.json`; daemon stdout/stderr are not retained as unlimited logs.

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

- `agent/hub.ts`: standalone start/stop/status/open CLI.
- `agent/extensions/pi-hub-web.ts`: explicit open/start client and stop command.
- `agent/extensions/lib/pi-hub-service-control.ts`: scoped atomic desired state, control lock and bounded diagnostics.
- `agent/extensions/lib/pi-hub-web-launcher.ts`: scoped discovery, locking, startup, stop.
- `agent/extensions/lib/pi-hub-web-main.ts`: standalone lifecycle and focus worker.
- `agent/extensions/lib/pi-hub-web-source.ts`: Intercom snapshots and reconnects.
- `agent/extensions/lib/pi-hub-web-server.ts`: authenticated HTTP/SSE adapter and acknowledgement API.
- `agent/extensions/lib/hub-attention.ts`: pure classification and atomic acknowledgement persistence.
- `agent/extensions/lib/pi-hub-web/board.ts`: ranking, check-in freeze and high-risk breakthrough.
- `agent/extensions/lib/pi-hub-web/`: bundled HTML, CSS, and browser JavaScript.

No new dependencies or frontend build step. The runtime pins an absolute Node
executable, entry point and the `tsx` loader already installed with Intercom. The
service uses a fixed source working directory rather than the launching Pi's cwd.

This lifecycle slice does **not** migrate native notifications: Pi still owns
notification delivery, focus suppression/dismissal and existing Accept once /
Reject / Show actions. There is no new agent-runtime ownership, automatic reply,
or permission authority. Automatic replies remain blocked by SDK reload/dispatch
races; the earlier Phase 3 experiment remains rolled back.

## Checks

```sh
node --experimental-strip-types --test agent/tests/pi-hub-web-*.test.ts
```

The integration test uses a short `/tmp` directory to stay below macOS Unix-socket
path limits, starts an isolated broker, and checks concurrent startup, presence,
broker reconnection, stop, and stale-endpoint recovery. Run resident lifecycle
coverage with `node --experimental-strip-types --test agent/tests/pi-hub-resident.test.ts`:
it uses temporary agent directories and injected browser opening, checks sticky
stop/launch races, crash recovery, private state and no-browser/source persistence,
and never installs a LaunchAgent or changes live notification preferences.

Browser regression tests cover frozen ordering, high-risk breakthrough, card actions,
Live/check-in controls, acknowledgements, archive/filter behavior, keyed DOM/todo
state, full permission details and mobile layout.

The browser tests use a separate headless Chrome profile, never your normal one.
On macOS it discovers the standard Google Chrome installation. Elsewhere set
`PI_HUB_CHROME` to a Chrome/Chromium executable; the test skips if none exists.
Set `PI_HUB_SCREENSHOT=/tmp/pi-hub-web.png` to capture its fixture dashboard.
