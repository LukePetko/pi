# Pi Hub v2 — attention router

Implementation spec. Self-contained: everything needed to build v2 on top of the current
`/hub-web` is in this file. Written against `docs/hub-web-brief.md` (2026-09-21).

## 0. Goal

v1 is a grid of sessions. v2 is an inbox: the hub sorts every session into one of four
buckets and only the first two get real estate. The person answers from the card, never
by scanning terminals.

Four principles, in priority order:

1. **Inbox, not a grid.** Buckets: `NEEDS_YOU` → `REVIEW` → `WORKING` → `PARKED`.
   Working and Parked are small and grey. Nothing in them asks for attention.
2. **Re-entry card.** A session that stops to ask something hands over
   goal · done so far · needs · options · recommendation. The person answers on the card.
3. **Batched interrupts.** The board refreshes on a check-in cadence, not on every event.
   Only high-risk permission gates break through, with an OS notification.
4. **Session box + thread cap.** Fixed end time, a cap on open threads (warning, not a
   block), and an end-of-session digest so nothing stays open in the person's head.

Non-goals: multi-machine, remote access, model-written summaries (later), auto-merge,
fixing the 1 s O(N) polling (keep it; only stop re-rendering everything).

---

## 1. State model

### 1.1 Bucket algorithm (hub server, pure function)

```ts
type Bucket = "NEEDS_YOU" | "REVIEW" | "WORKING" | "PARKED";
type Reason = "permission" | "prompt" | "question" | "error" | "done" | null;

function classify(s: Session, acks: Record<string, number>): { bucket: Bucket; reason: Reason } {
  if (s.permissions.length > 0)          return { bucket: "NEEDS_YOU", reason: "permission" };
  if (s.turnState === "prompt")          return { bucket: "NEEDS_YOU", reason: "prompt" };
  if (isRunning(s.status))               return { bucket: "WORKING",   reason: null };

  // idle from here
  const returned = s.turnState === "returned" && s.lastAgentEnd != null;
  const acked    = acks[s.id] === s.lastAgentEnd;
  const todosOpen = s.todos && s.todos.total > 0 && s.todos.completed < s.todos.total;

  if (returned && !acked && s.lastAgentEndError) return { bucket: "NEEDS_YOU", reason: "error" };
  if (returned && !acked && (s.handoff || todosOpen)) return { bucket: "NEEDS_YOU", reason: "question" };
  if (returned && !acked)                 return { bucket: "REVIEW", reason: "done" };
  return { bucket: "PARKED", reason: null };
}

const isRunning = (status: string) => status === "thinking" || status.startsWith("tool:");
```

Phase 1 runs this with `turnState` derived as `status === "idle" ? "returned" : "running"`
and `lastAgentEnd = lastActivity` — approximate, but good enough to ship the UI first.

### 1.2 Sorting inside a bucket

- `NEEDS_YOU`: `risk === "high"` first, then `enteredStateAt` ascending (longest wait first).
- `REVIEW`: `lastAgentEnd` descending.
- `WORKING`: `lastActivity` descending.
- `PARKED`: `lastAgentEnd ?? startedAt` descending. Rows older than 72 h collapse under
  "Archive idle > 72 h".

Never sort by `startedAt` for ranking (it resets on Pi reload).

### 1.3 Display name

```
name = !runtimeFallbackAlias ? name
     : todos?.current          ? todos.current
     : basename(cwd)
```

Show the short id (`id.slice(0, 8)`) in mono next to it.

### 1.4 Open-thread count (for the cap)

`open = count(sessions where bucket !== "PARKED")`.

---

## 2. Wire schema (pi-intercom `types.ts:13`, `broker/client.ts:758`, `broker/broker.ts:464,877`)

Add to the session record. All optional so old producers still work.

```ts
turnState?: "running" | "returned" | "prompt";
lastAgentEnd?: number;        // ms epoch of the last agent_end
lastAgentEndError?: boolean;  // agent_end carried an error / abort
lastUserTurn?: number;        // ms epoch of the last user-initiated turn
enteredStateAt?: number;      // ms epoch when turnState/status last changed
handoff?: Handoff | null;     // see §4
```

`Handoff`:

```ts
interface Handoff {
  goal: string;                 // one sentence
  done: string;                 // 1–3 sentences
  needs: string;                // the exact question or decision
  options?: { id: string; label: string; detail?: string }[]; // 2–4
  recommendation?: string;      // option id
  risk?: "low" | "high";        // cost of a wrong pick
  at: number;                   // ms epoch
}
```

Permission entries gain risk:

```ts
permissions: { id: string; title: string; risk: "low" | "high"; tool: string; summary: string }[];
```

Broker passes all new fields through untouched; they are producer-owned.

---

## 3. Producer (pi-intercom `index.ts:774`, `index.ts:1695`)

Subscribe and set fields. The producer stays dumb: it reports *what happened*, the hub decides
*what it means*.

| Event | Set |
| --- | --- |
| `agent_start` | `turnState="running"`, `enteredStateAt=now`, `handoff=null` if the turn was user-initiated |
| `turn_start` (user message) | `lastUserTurn=now`, `handoff=null` |
| `agent_end` | `turnState="returned"`, `lastAgentEnd=now`, `lastAgentEndError=!!event.error` (verify field name in `docs/extensions.md`), `enteredStateAt=now` |
| `ui_prompt_start` | `turnState="prompt"`, `enteredStateAt=now` |
| `ui_prompt_end` | `turnState = agentRunning ? "running" : "returned"`, `enteredStateAt=now` |
| `session_shutdown` | existing cleanup |

Also: the producer keeps the last `handoff` in memory and includes it in presence on reconnect,
so a hub restart does not lose open cards.

Input path (for §5.2): handle a broker message `{ type: "input", sessionId, text }` by calling
`pi.sendUserMessage(text)` (verify exact API name/signature in `docs/extensions.md`; if the
running Pi version lacks it, the hub server falls back to `tmux send-keys -t <tmuxPane> -l <text> Enter`,
which it can already do because it resolves the pane for Focus).

---

## 4. Handoff extension (new: `agent/extensions/handoff.ts`)

### 4.1 Tool

```ts
pi.registerTool({
  name: "handoff",
  label: "Handoff to user",
  description: "Call this BEFORE ending your turn whenever you need a decision, an answer, or approval from the user. Then end the turn.",
  parameters: Type.Object({
    goal: Type.String({ description: "What this session is trying to achieve, one sentence" }),
    done: Type.String({ description: "What is finished so far, 1-3 sentences" }),
    needs: Type.String({ description: "The exact question or decision you need" }),
    options: Type.Optional(Type.Array(Type.Object({
      id: Type.String(), label: Type.String(), detail: Type.Optional(Type.String())
    }), { minItems: 2, maxItems: 4 })),
    recommendation: Type.Optional(Type.String({ description: "id of the option you recommend" })),
    risk: Type.Optional(StringEnum(["low", "high"]))
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    publishHandoff({ ...params, at: Date.now() });   // via intercom client → broker
    return { content: [{ type: "text", text: "Handoff recorded. End your turn now and wait for the reply." }], details: {} };
  }
});
```

### 4.2 System-prompt addition (via `before_agent_start`)

Append to the system prompt:

```
When you must stop and ask the user for a decision, an answer, or approval, call the
`handoff` tool first with goal / done / needs / options / recommendation, then end your
turn. Do not ask in prose without calling `handoff`. Keep `needs` to one question.
```

### 4.3 Clearing

`handoff` is cleared by the producer on the next user-initiated `turn_start`. The hub also
clears its copy when a reply is sent from the card (optimistic).

---

## 5. Hub server (`pi-hub-web-server.ts`, `hub-permissions.ts`, `confirm-dialog.ts`)

### 5.1 Snapshot enrichment

`/api/events` snapshot gains, per session: `bucket`, `reason`, `waitingSince`
(= `enteredStateAt` for NEEDS_YOU, else null), `displayName`. And a top-level `session` object (§5.5).

### 5.2 New endpoints

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| POST | `/api/reply` | `{ id, text }` | Send `text` to session `id` (§3 input path). Clears hub-side `handoff`. |
| POST | `/api/ack` | `{ id }` | `acks[id] = session.lastAgentEnd`; persist. Session leaves REVIEW/NEEDS_YOU(question). |
| POST | `/api/permissions/decision` | `{ id, decision: "once" \| "session" \| "reject" }` | Extend existing with `session` (§5.3). |
| GET | `/api/session` | — | Session box state. |
| POST | `/api/session/start` | `{ durationMin, checkinMin, cap, interrupts }` | Start a session box. |
| POST | `/api/session/end` | — | Write digest (§5.6), return `{ digestPath, markdown }`. |

Option pick from a handoff card sends `text = "${option.id}: ${option.label}"`.
Same-Origin and bearer rules as existing POSTs.

### 5.3 Permission risk + "allow for session" (`confirm-dialog.ts:204`, `hub-permissions.ts:216`)

Classify at gate creation. First matching rule wins.

| Risk | Rule |
| --- | --- |
| `high` | path outside `cwd`; bash containing `rm -rf`, `git push`, `git reset --hard`, `sudo`, `curl`, `wget`, `npm publish`, `docker`, `ssh`, `scp`; any write under `~/.ssh`, `~/.pi`, `.env*` |
| `low` | everything else that is gated (writes inside the worktree, test runs, installs) |

Gates are still decided by confirm-dialog exactly as today; risk only affects display, sort,
and notifications. `autoApprove: "none" | "low"` in `intercom/config.json`, default `"none"`.
Switching to `"low"` resolves low-risk gates automatically and logs them in the card footer.

`decision: "session"` stores `{ tool, firstWord(bashCommand) }` in a per-session allow-list
(RAM, lifetime of the Pi process). Future gates matching tool + first word **and** `risk === "low"`
resolve automatically. High-risk gates never auto-resolve.

### 5.4 Notifications

Fire an OS notification (`osascript -e 'display notification "…" with title "Pi Hub"'`;
use `terminal-notifier` if on PATH) when:

- a new permission with `risk === "high"` appears — always, regardless of `interrupts`;
- any new NEEDS_YOU entry — only if `session.interrupts === "all"`.

Never for WORKING, REVIEW, or PARKED changes. Debounce: one notification per session per
30 s.

### 5.5 Session box

`~/.pi/agent/cache/hub-web/<scopehash>/session.json`:

```json
{
  "startedAt": 1789647567695,
  "endsAt":    1789654767695,
  "checkinMin": 25,
  "cap": 4,
  "interrupts": "high",
  "acks": { "<sessionId>": 1789647567714 }
}
```

`interrupts: "high" | "all"`. Defaults when no session is running: `checkinMin=25`, `cap=4`,
`interrupts="high"`. `acks` persists across hub restarts even with no session box.

### 5.6 Digest (on `/api/session/end`)

Write `~/.pi/agent/cache/hub-web/<scopehash>/digests/<ISO-timestamp>.md`:

```
# Session digest — 2026-09-21 09:45 → 12:00

## Needs you (2)
- **Replay detector — threshold sweep** (iad-replay) — waiting 4 min
  Needs: Which threshold goes to staging?  Options: A / B (recommended) / C
- …

## Ready for review (1)
- **Rank candidates and recommend** (dot-web-components) — todos 3/3

## Working (1)
- **Hub web — attention inbox** (.pi) — todos 12/20 — current: Wire re-entry card to session events

## Parked (2)
- …
```

Content comes from the snapshot only: name, cwd basename, bucket, todos, `handoff.needs`,
options. No model call.

---

## 6. UI (`pi-hub-web/app.ts`, replace classification at `:36` and cards at `:118`)

### 6.1 Layout (desktop, 1440 wide; single column below 1100)

```
┌ header ───────────────────────────────────────────────────────────────┐
│ Pi Hub                     [● Live · local] [Session · 1h12 left] [Threads 4/4 · at cap] │
├ attention strip ───────────────────────────────────────────────────────┤
│ NEEDS YOU 2 · longest 4 min │ REVIEW 1 │ WORKING 1 │ PARKED 2 │ [search] │
├ main (flex-grow) ───────────────────────┬ rail (400px) ────────────────┤
│ Needs you                               │ Session box                 │
│   [re-entry card]                       │   time left, progress       │
│   [permission card]                     │   next check-in · cadence   │
│ Ready for review                        │   interrupts · threads/cap  │
│   [review card]                         │   [End session → digest]    │
│                                         │ Working · N   (mini rows)   │
│                                         │ Parked · N    (mini rows)   │
├ footer ───────────────────────────────────────────────────────────────┤
│ LOCAL ONLY · No prompts or messages sent        Open: /hub-web · Stop │
└───────────────────────────────────────────────────────────────────────┘
```

Palette (keep v1's): bg `#12121c`, card `#1a1a27`, border `#2c2c3d`, text `#e8e8f0`,
muted `#9a9ab0`, accent `#b9a7f5`, green `#7fd6b4`, yellow `#f0c674`, red `#f2a0a0`.
Needs-you cards use a yellow-tinted border; review cards green-tinted. Mono for paths and ids.

### 6.2 Cards

**Re-entry card** (`reason: "question" | "prompt" | "error"`):

- header: yellow dot · displayName · chip `waiting Nm` · chip `high risk` (if `handoff.risk`) · short id
- meta line (mono): cwd · model · context % · todos x/y
- block: `Goal` / `Done so far` / `Needs you` from `handoff`. No handoff → show the last
  assistant message text under `Needs you` (hub fetches it via a new `lastAssistantText`
  field the producer sets on `agent_end`, capped at 600 chars).
- options as `<button>`s; recommended one gets the accent border and label `agent recommends`.
- footer: text input `Or type a reply…` (Enter → `/api/reply`) · `Open terminal ↗` (existing focus)
- `reason: "error"`: block shows the error text; buttons: `Retry` (reply "continue"), `Open terminal`.

**Permission card** (`reason: "permission"`):

- header: yellow dot · displayName · chip `waiting Ns` · chip `low risk · writes files` / `high risk · <why>`
- line: `Wants to run` + `<code>` summary (from `/api/permissions/inspect`)
- buttons: `Allow once` (accent) · `Allow for this session` · `Deny`
- caption: `Reads inside the worktree are auto-approved. Writes and network always ask.`
  (adjust to actual `autoApprove` setting)

**Review card** (`bucket: "REVIEW"`):

- header: green dot · displayName · chip `done Nm ago` · short id
- meta line
- bullets: todos completed (subjects), last `handoff.done` if any
- buttons: `Open terminal` (accent) · `Accept` (→ `/api/ack`) · `Send back with a note` (opens the
  reply input; on send → `/api/reply` then the session goes WORKING)

**Working row** (rail, no card chrome): green dot · displayName · `active Ns ago` · mono cwd ·
todos x/y · `▸ current todo` · thin context bar. No buttons. Caption under the section:
`nothing to do here`.

**Parked row**: grey dot · displayName · mono `cwd · todos · idle Nh` · `Resume` (focus).
`Archive idle > 72 h` toggles collapse of old rows.

### 6.3 Check-in freeze

- Keep `displayed` and `pending` snapshots. Every `/api/events` message updates `pending` only.
- Apply `pending → displayed` when: the cadence timer fires (`checkinMin`, aligned to the
  session start), the person clicks the badge, or the person acts on any card.
- Break-through: apply immediately if `pending` contains a NEEDS_YOU entry with
  `risk === "high"` that `displayed` lacks.
- Header badge while frozen: `N changes since 11:20 · refresh`. Attention-strip counts show
  `displayed` numbers.
- With no session box running, cadence = 25 min by default; a `Live` toggle in the header
  disables the freeze (v1 behaviour).

### 6.4 Rendering

Keyed DOM by session id: update the card in place when its bucket is unchanged, move it when
the bucket changes, never rebuild the whole board. Todo rows re-render only when the
`todos` object changed (compare `completed`, `current`, `total`).

### 6.5 Thread cap

Header chip: `Threads N / cap`. When `N >= cap`: chip turns yellow, `at cap`; the session box
shows `Finish a review before starting another thread.`; Parked `Resume` buttons get a
confirm tooltip. Never blocks anything.

---

## 7. Persistence summary

| What | Where | Survives hub restart | Survives Pi restart |
| --- | --- | --- | --- |
| acks, session box | `cache/hub-web/<scopehash>/session.json` | yes | yes |
| digests | `cache/hub-web/<scopehash>/digests/*.md` | yes | yes |
| handoff | producer RAM + presence replay | yes | no (session gone anyway) |
| per-session allow-list | Pi process RAM | yes | no |
| pending permissions | as today | yes | no |

---

## 8. Phases and acceptance

### Phase 1 — UI on existing data (no producer changes)

- `classify()` with the phase-1 approximation (§1.1 last paragraph).
- Four buckets, all card types, keyed rendering, check-in freeze with a default 25 min cadence
  and the `Live` toggle.
- Permission card wired to the existing `once | reject`.
- `/api/ack` + `acks` persistence.

Accept when: with 3 sessions open — one asking a question, one mid-tool, one finished —
the board shows one card in Needs you, one row in Working, one card in Review; approving a
gate from the card resolves it in the terminal; `Accept` moves the finished one to Parked;
no card moves while frozen except a high-risk gate.

### Phase 2 — Producer signals

- §2 fields, §3 events, `lastAssistantText`.
- `classify()` uses real `turnState` / `lastAgentEnd`.

Accept when: a session that has been idle since start shows in Parked, not Review; a
session that returned with todos open shows in Needs you within 2 s with a correct
`waiting` timer; `ui_prompt_start` from an extension shows as `prompt` even mid-turn.

### Phase 3 — Handoff + reply

- `handoff.ts` extension (§4), `handoff` on the wire, `/api/reply`, input path.

Accept when: the agent calls `handoff` and ends its turn → the card shows goal/done/needs
and options; clicking option B sends `B: …` to the session and the session goes to Working;
typing a reply does the same; the card disappears without a manual refresh.

### Phase 4 — Risk, notifications, allow-for-session

- §5.3, §5.4, `decision: "session"`.

Accept when: `git push` in a gate produces an OS notification and breaks the freeze; a
worktree write does neither; `Allow for this session` on `pnpm test` stops further
`pnpm …` low-risk gates from appearing.

### Phase 5 — Session box + digest

- §5.5, §5.6, header chips, rail box, `End session`.

Accept when: starting a 2 h box shows the countdown and next check-in; the cadence follows
`checkinMin`; ending writes a digest file and shows it; `acks` survive a hub restart.

---

## 9. Open decisions (defaults chosen; change in config)

| Decision | Default | Where |
| --- | --- | --- |
| Auto-approve low-risk gates | off (`autoApprove: "none"`) | `intercom/config.json` |
| Thread cap | 4, warning only | `session.json` |
| Check-in cadence | 25 min | `session.json` |
| Interrupts | high-risk only | `session.json` |
| Parked archive threshold | 72 h | UI constant |
| Handoff fallback | last assistant message, unsummarised | §6.2 |
