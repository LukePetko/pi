# Pi Hub web: technical brief

Based on current working-tree source and the installed Intercom package.

## 1. Entry points

Global extension discovery loads `agent/extensions/pi-hub-web.ts:4`; its default export registers `hub-web` (TUI-only). `agent/extensions/lib/pi-hub-web-launcher.ts` authenticates/reuses an endpoint or spawns detached Node+tsx `agent/extensions/lib/pi-hub-web-main.ts`. `/hub-web` opens a token-fragment browser URL; `/hub-web stop` posts `/api/stop`. Signals or five browserless minutes also stop it, without stopping Pi sessions.

## 2. Session discovery

`agent/extensions/lib/pi-hub-web-source.ts` connects to `~/.pi/agent/intercom/broker.sock` (length-prefixed JSON), auto-starting the broker using `intercom/broker.pid`; settings: `intercom/config.json`. All instances/CWDs sharing the agent directory and `PI_INTERCOM_SCOPE_ID` are visible, excluding the dashboard itself. No transcript/process scanning. Join/leave/presence events trigger re-listing after 50ms; broker reconnect retries every 2s. `PI_CODING_AGENT_DIR` overrides the agent root.

## 3. State model

Envelope: `{connected,sessions}`. `id` uses `PI_INTERCOM_STABLE_ID`, configured `stableId`, or the SDK session ID; `name` from Pi's session name or a synthesized alias (`runtimeFallbackAlias`). Context supplies `cwd/model`; process/environment supply `pid/tmuxPane`. `startedAt` is runtime registration, not OS birth. Broker supplies `endpointEpoch` (registration identity) and `trustedLocal` (local Unix transport); `peerUid` is declared but unset. `lastActivity` means presence receipt, not user attention. `ctx.getContextUsage()` supplies optional `contextPct/contextTokens/contextWindow`; startup, compaction and older SDKs cause missing/stale values. Model defaults to `unknown`; absent status/context display unknown.

`status` is the first active `tool:<name>`, otherwise `agentRunning ? thinking : idle` (optional configuration suffix). Browser “working” means thinking/tool without pending permissions.

Todo replay supplies `todos:{total,completed,current,tasks:[{id,subject,status}]}`. `current` selects first in-progress, then pending, then last task; rows cap at 200, subjects at 256 characters. Pending gates supply `permissions:[{id,title}]`.

Complete, unredacted live `/api/events` session, captured 2026-09-21T09:26:02Z:

```json
{
  "id":"01a0af0c-8196-73ee-8db4-ae6304831cdb","endpointEpoch":"b4d0d7ee-0041-40ac-bc41-b23e28f67cbe",
  "name":"subagent-chat-01a0af0c-8196-73ee","runtimeFallbackAlias":true,
  "cwd":"/Users/lukaspetko/innovatrics/bh/AprilTagPoC","model":"gpt-6-astra","pid":75405,
  "startedAt":1789647567695,"lastActivity":1789647567714,"status":"idle","tmuxPane":"%10","trustedLocal":true,
  "todos":{"total":1,"completed":1,"current":"Trace proxy submission feedback","tasks":[{"id":1,"subject":"Trace proxy submission feedback","status":"completed"}]},
  "permissions":[]
}
```

## 4. Events and detection

Hub command: no `pi.on`. Intercom: `session_start`/`session_shutdown` register/cleanup; `agent_start`/`agent_end`, `tool_execution_start`/`tool_execution_end` update status; `turn_start` refreshes identity/context; `model_select` updates model. `turn_end`/`tool_result` only handle bookkeeping/errors.

`agent/extensions/todos-web.ts`: replay `session_start`, `session_tree`, `session_compact`; publish successful `todo` `tool_execution_end`; remove on `session_shutdown`. `agent/extensions/confirm-dialog.ts`: `tool_call`/`session_shutdown`; its pending requests override display with “Permission needed”. Generic input/other permission waits remain undetected. No `ui_prompt_start`/`ui_prompt_end` or `agent_settled` subscription: idle does not prove task completion.

## 5. Transport and UI

GET `/api/health`, `/api/events` (full-snapshot fetch-SSE; 15s heartbeat); POST `/api/focus`, `/api/stop`, `/api/permissions/{inspect,decision}` (`once|reject`). Loopback-only, bearer authentication; POSTs require same Origin. Permission inspection returns full description/input; decisions resolve the owning gate once. Vanilla TypeScript/DOM/CSS in `agent/extensions/lib/pi-hub-web/`, esbuild-transformed at startup. Cards sort by `(startedAt,id)`. Focus re-resolves PID, walks `ps` ancestry, selects tmux pane/window, then focuses AeroSpace through a 10s worker.

## 6. Persistence

`~/.pi/agent/cache/hub-web/<scopehash>/` holds `endpoint.json` (PID/origin/token), transient `launch.lock`, and hashed `[id,pid]` records under `todos/`, `permissions/` (0600 files/0700 directories). Scopehash is SHA-256(scope)'s first 16 hex characters. Roster and permission payloads/decisions are RAM; todo history comes from Pi branches. Restarting Hub rebuilds state from still-running owners; restarting Pi loses pending approvals. Browser token uses `sessionStorage`; filters/expansion disappear on reload.

## 7. Limits and known problems

1s O(N) file polling; every snapshot rerenders all cards/todo rows; 128 broker sessions/16 SSE streams. Requests over 1MiB require terminal approval. Scoped stable-ID collisions replace peers; Pi reload resets `startedAt`. Parallel tools collapse to one label. Detached/headless focus fails; latest tmux client/first matching window can misfocus. Stale/missing caches hide details. Restart the bridge for changed assets. An unhealthy-but-live bridge blocks relaunch and cannot be stopped through the health-gated command. Same-user tool, not a security sandbox.

## 8. Extension points

- Producer/status/input hooks: `agent/npm/node_modules/pi-intercom/index.ts:774`, `agent/npm/node_modules/pi-intercom/index.ts:1695`.
- Wire fields: `agent/npm/node_modules/pi-intercom/types.ts:13`, `agent/npm/node_modules/pi-intercom/broker/client.ts:758`, `agent/npm/node_modules/pi-intercom/broker/broker.ts:464`, `agent/npm/node_modules/pi-intercom/broker/broker.ts:877`.
- Enrichment/schema: `agent/extensions/lib/hub-todo-source.ts:11`, `agent/extensions/lib/pi-hub-web-server.ts:9`.
- Permission lifecycle: `agent/extensions/confirm-dialog.ts:204`, `agent/extensions/lib/hub-permissions.ts:216`.
- UI classification/cards/filter: `agent/extensions/lib/pi-hub-web/app.ts:36`, `agent/extensions/lib/pi-hub-web/app.ts:118`.
