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
The bridge listens on `http://127.0.0.1:47831` by default; authenticated discovery lets other
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

Set `PI_HUB_PORT` to override the port for another scope, or `0` to explicitly
request an ephemeral test port. Restart an existing service to apply a port change.
A busy port fails startup rather than silently selecting another address.

The executable `agent/hub.ts` also works directly when Node is on PATH. Set
`PI_CODING_AGENT_DIR` and `PI_INTERCOM_SCOPE_ID` consistently to select a scope.
`start` and `open` are explicit user actions, as is `/hub-web`: they clear stopped
intent. Automatic clients using `ensureHubWeb` cannot clear it. Authenticated
`/api/stop` and CLI stop both durably save stopped intent and serialize with
launches. Launcher stop requests are revision/instance-fenced, so a delayed stop
cannot undo a later explicit start or stop a replacement process. Stop never
removes acknowledgements or other user data. A signal/crash
leaves desired intent unchanged; run `start` to recover, or a notification adapter
may restart it when intent is still running.

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
Status never starts it. Pi notification adapters automatically ensure the service
while desired intent permits, including quiet ten-second registration heartbeats.
Lifecycle diagnostics are private and capped at 16 KiB of text in
`service.log.json`; daemon stdout/stderr are not retained as unlimited logs.

Only sessions in the launching Pi's Intercom scope appear. The bridge hides itself
in the web dashboard, but other Intercom clients can see a helper entry named
`Pi Hub web (dashboard)` while it runs. That entry is not an agent.

Updating these files does not hot-reload an already-running bridge. After a config
update, reload Pi and run `/hub-web stop`, then `/hub-web` to start the new code.

## Local security boundary

- Loopback binding, exact Host/Origin checks, no CORS, and a restrictive CSP.
- Browser APIs require the private random bearer token; browser POST endpoints
  require the exact Origin. Focus accepts a session ID and resolves its PID from a
  fresh broker list; the browser cannot supply a PID or command.
- Versioned notification registration/event POSTs use that scoped private bearer
  credential but reject all browser Origins and cross-site requests. Native action
  POSTs use a separate per-alert capability, never an admin token. Bodies are capped
  at 8 KiB; there is no general command, message or reply endpoint.
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

## Resident notifications

`macos-notify.ts` is now a thin authenticated event adapter. Pi retains the agent
runtime, local permission UI and all decision authority. Completion remains at
`agent_end` (not `agent_settled`), including randomized title/image, Glass sound,
project/duration and `/notify-test`. Generic UI prompts do not create alerts.
The service owns OS delivery/assets, native routing records, deduplication,
focus suppression/withdrawal and native Accept once / Reject / Show handling.
Focus acknowledgement neither decides a permission nor acknowledges a Hub card.
No automatic replies are implemented: SDK reload/dispatch races still block them;
the Phase 3 experiment remains rolled back.

### Identity, recovery and persistence

- Producers register OS PID/birth/UID, SDK session/runtime nonce and monotonic
  per-process runtime sequence. Broker-backed registrations additionally match a
  fresh scoped roster ID, registration timestamp and endpoint epoch. Non-Intercom
  show-only/completion registrations are explicitly birth-validated only.
- A quiet ten-second heartbeat re-registers even an idle/waiting Pi after service
  restart. Broker-only rebinds retain the SDK runtime and notices, with their own
  monotonic binding fence; delayed old bindings/events cannot replace newer ones.
  Disconnection or an unavailable roster is unknown, not permission resolution.
  Explicit resolution/shutdown uses the last known exact SDK generation without
  re-registration: even a dead owner or obsolete broker binding can revoke only
  its own notices, never reactivate authority or affect a replacement runtime.
  Broker registration time is not the independent gate owner's lifetime (ordinary
  Intercom reconnect normally retains `startedAt`). Notification gate validation
  uses live PID/birth/UID/roster fences plus the existing owner's exact request and
  token, rather than expiring an old pending gate solely by registration time.
- Actions revalidate the exact origin and, for actionable notices, the live gate
  in the service-derived scoped permissions directory. Stored registrations alone
  never acquire authority after restart. Replaced SDK runtimes/PIDs cannot inherit
  alerts or permission capabilities. Focus targets the originating Pi, not Hub.
  A nondefault tmux socket is accepted only if it is a same-UID real socket with
  live originating-Pi pane ancestry. Executable paths come from fixed service
  candidates, never producer PATH, environment, shell strings or broker paths.
  OS identity probes are asynchronous. Focus and cold image/app preparation run
  in bounded workers, not the Hub HTTP event loop. Durable mutations/reservations
  are serialized separately from broker/focus/OS work: one slow origin cannot
  block another origin's terminal event or the service's durable stop fence.
  Durable close also seals that coordinator's writer authority: late old cleanup
  or reconciliation cannot overwrite a replacement service's ledger.
- `notifications.json` is an atomic private scoped ledger: identities/fences,
  event IDs, random OS IDs, minimal presentation and per-alert capabilities/state.
  No transcripts, tool inputs, runtime continuations or approval policies persist.
  Native records remain in the canonical user-wide `cache/native-permissions/requests`
  root, tagged by scope owner. Both native bundle identities remain unchanged;
  installation is serialized and cleanup only removes owned random IDs.
- Acceptance and OS identity persist before dispatch. Duplicate retries do not
  allocate new IDs or beep. Pi has a 64-event in-memory queue with a five-minute
  horizon; terminal/tombstone bookkeeping is retained for 24 hours (failed cleanup
  remains recorded for retry). Ledger and
  runtime tables cap at 4096 each and reject capacity rather than evict live state.
  Resolution-before-request leaves a durable tombstone. A pending gate does not
  expire merely because it has waited a long time.
- Restart reconciles delivered/pending OS IDs without replay, retaining permanent
  completion and permission alerts. Missing/manually dismissed, focus-acknowledged,
  resolved and stopped notices are never re-added. If OS enumeration is unavailable,
  state remains unknown, with no replay. The OS-add/ledger crash gap is intentionally
  at-most-once: an uncertain alert can be lost, never blindly re-sent.
- Native prepare failure may use removable Show-only terminal-notifier fallback.
  Once a native add might have happened, an error never triggers a second sender.
  Failed/stale native actions leave the Pi permission prompt intact. No AppleScript
  fallback, persistent approval, service-origin permission decision or browser
  dependency is introduced.

### Rollout and stopped-service behavior

Stop the old service **before** updating/reloading clients; capability negotiation
refuses a running older service. Reload each Pi adapter and explicitly start the
new service (`hub start` or `/hub-web`). A reload must dispose the old direct sender
before enabling the resident adapter for that runtime; do not run both extensions
side by side. Legacy in-flight records keep their old callbacks until their old Pi
withdraws them; this service neither adopts nor broadly deletes legacy records.
Other scopes continue using the same canonical native host without sharing authority.

Explicit stop is sticky: automatic ensure/heartbeats cannot undo it, pending sends
are cancelled, all owned capabilities are durably revoked, and only owned OS IDs
are withdrawn (including late deliveries). Pi still handles every local permission
prompt. Events can retry for five minutes if the user later explicitly starts the
service; there is no direct-Pi timeout fallback and no historical completion replay.
Owned routing records are revoked before OS removal, independently of other slow
removals. OS cleanup is concurrency-bounded and gets the existing two-second stop
deadline; unfinished cleanup remains revoked in the private ledger and is retried
at next start, never re-delivered. No launchd job or live notification preference
is installed/changed by this rollout.

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
