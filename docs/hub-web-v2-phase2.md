# Hub web v2 — Phase 2 producer signals

Implements Phase 2 only of [the spec](hub-web-v2-spec.md). No reply endpoint, handoff tool/system prompt, approval policy, or notification changes.

## Transport and identity

`agent/extensions/handoff.ts` currently registers lifecycle hooks only. It uses the existing public Intercom extension registration events/channel to obtain its own live roster identity (effective Intercom ID, PID, startedAt, **broker-owned endpointEpoch**). It does not modify Intercom or publish arbitrary fields through its presence schema.

The producer atomically writes a private, bounded lifecycle snapshot under `cache/hub-web/<scopehash>/lifecycle/` (directory 0700, files 0600). Filenames include the exact broker registration identity. The existing Hub enrichment poll reads these once per second alongside todos/permissions, validating identity and whitelisting fields. Unhydrated initial snapshots do not mark the board connected, so the check-in freeze does not capture unenriched presence as its initial board. No transcript files are read.

Hub/browser restarts replay the current file. Broker-only reconnect rebinds the existing in-memory state to its new endpoint epoch without resetting timestamps or producer generation. An actual Pi runtime reload gets a new random lifecycle generation and fresh state. Shutdown invalidates outstanding roster lookups, drains serialized writes, and removes only its own epoch-keyed files. Old writes/cleanup cannot overwrite or delete the replacement registration's file, including same-ID/PID/startedAt replacement. Missing endpointEpoch (older Intercom) disables this producer bridge rather than guessing identity; absent lifecycle data retains the Phase 1 approximation.

## Verified SDK adaptations

Verified installed `@earendil-works/pi-coding-agent` `docs/extensions.md`, `dist/core/extensions/types.d.ts`, `agent-session.js`, and `examples/extensions/event-bus.ts`:

- `agent_end` has `messages`, **not `error`**. The terminal assistant message supplies `stopReason` (`error`/`aborted`) and optional `errorMessage`. Text content blocks only are used; error text takes precedence for failures; the published text is capped at 600 characters.
- `agent_end` can precede automatic retry/compaction/queued continuation. It captures a provisional result; **`agent_settled` publishes returned state**, when no automatic continuation remains. `lastAgentEnd` is the timestamp of that final low-level end; `enteredStateAt` is the time the returned state actually begins. Intermediate ends never produce Review/Needs-you cards.
- `turn_start` has no user-message discriminator and occurs in tool loops. Committed user `message_start` records `lastUserTurn` instead (including user-message dispatch from extensions). No input intent or tool-loop boundary invents a user turn.
- Prompt events have no ID/answer callback. Balanced prompt depth overrides running, including mid-tool; nested prompts preserve the original wait timestamp. Prompt end restores running or returned/fresh idle. Generic prompt cards direct the person to the terminal and never imply that an HTTP reply could answer an extension dialog.

Fresh producers explicitly publish `turnState: returned, lastAgentEnd: null`; classification distinguishes them from legacy producers. Real running/returned/prompt metadata is authoritative over lagging Intercom status. Acknowledgements use real completion timestamps and compare live registration/generation plus cached and freshly read lifecycle state. Browser requests also include the displayed generation. Existing `{id}` requests and legacy producers remain supported.

Assistant fallback text is rendered with textContent, never HTML. Permission precedence, exact focus, bearer/Origin checks and notification behavior are unchanged. Captured action lookups never replace real lifecycle state based on a presence `lastActivity` timestamp; an acknowledgement response preserves newer lifecycle already observed by the source.

A successful permission action gets one bounded follow-through (5 seconds) for the acted-on exact ID/PID/startedAt/endpointEpoch/generation. A producer-owned monotonic `lifecycleRevision` distinguishes the authoritative prompt-end update from the still-prompt action response, even within one millisecond. That next newer lifecycle snapshot, after the gate is absent, updates only that session through the default freeze. A genuinely new prompt is displayed as a prompt, never guessed away; unrelated pending cards stay frozen. Disconnect, replacement, expiry, or consumption cancels the follow-through.

## Validation

New tests:

- `hub-lifecycle.test.ts`: fresh Parked, legacy fallback, provisional/continued runs, terminal error/abort, 600-character bound, nested prompt priority, exact registration/cache validation, stale writes/cleanup and Hub replay.
- `handoff-lifecycle.test.ts`: real producer hook wiring, both registry load orders, pre-turn publication, broker reconnect preserving timestamps, same-process runtime reload, late roster results and shutdown.
- `hub-lifecycle-ack.test.ts`: true timestamps, fresh idle/provisional/prompt refusal, stale completion/generation/endpoint guards, and an ack response racing newer lifecycle with older presence time.
- `hub-lifecycle-followthrough.test.ts`: one exact-runtime asynchronous gate follow-up through the freeze, preserving new prompts and unrelated cards, with disconnect/replacement/expiry cancellation.
- `pi-hub-web-lifecycle-browser.test.ts`: Chrome + actual default 1-second file poll + SSE + UI; fresh idle Parked, returned open todos Needs-you **within 2 seconds under Live**, authoritative waiting timestamp, check-in prompt override, escaped assistant text, Hub restart replay, and real-stamp Accept while broker presence lags. A second Chrome test approves a real waiting permission owner while frozen, then publishes prompt-end after the response and verifies only that session moves to Working.

Run:

```sh
PI_NATIVE_NOTIFICATION_TEST=1 node --experimental-strip-types --test agent/tests/*.test.ts
```

Reload Pi sessions to load the tracked producer; restart `/hub-web` to load the updated server/assets. Older sessions keep legacy approximation until reload. Pi runtime reload intentionally clears producer state; broker/Hub reconnect does not.
