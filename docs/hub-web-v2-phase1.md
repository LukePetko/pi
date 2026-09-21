# Hub web v2 — Phase 1 implementation

Implements only §8, Phase 1 of [the supplied spec](hub-web-v2-spec.md). The repository did not contain that file; it was imported from `/Users/lukaspetko/Downloads/pi-hub-v2-spec.md` (Markdown formatting normalized). No `pi-intercom` source or producer events were changed.

## Shipped

- Server-side pure classification and display-name enrichment using existing session data. Idle is treated as returned and `lastActivity` approximates `lastAgentEnd`, `enteredStateAt`, and waiting time. Configured Intercom status suffixes such as `thinking · custom` are normalized before classification.
- Needs-you and review cards; compact working and parked rows; collapsed parked archive after 72 hours. Per-bucket ranking follows the spec, with session ID breaking ties.
- First connected snapshot displays immediately. Subsequent ordinary/low-risk changes are held in `pending`; `displayed` changes at the 25-minute check-in, manual refresh, a card action, or while Live updates is enabled. Connection/action availability still updates while frozen.
- Keyed session DOM: bucket transitions move the same element. Unchanged cards and todo rows are reused. Todo comparison includes task contents as well as counters, so editing a subject/status cannot leave stale rows.
- Existing permission inspection and `once | reject` decisions. Full details must load before buttons become usable. Successful decisions immediately remove that gate from the Hub view, even while the file-backed source catches up.
- Same-Origin, bearer-protected `POST /api/ack`. Acknowledgements are serialized and atomically persisted in `cache/hub-web/<scopehash>/session.json` as `{ "acks": { "session-id": lastAgentEnd } }`. Existing unrelated keys are preserved for Phase 5. Files are private; invalid/corrupt state is never silently overwritten. State is bounded to 1 MiB.

## Deliberate adaptations / deviations

1. **No real question text or reply transport in Phase 1.** Re-entry cards explicitly say the question is inferred from open todos and direct the person to the terminal. Goal/progress use available names/todos; no transcript is read and no summary is invented. Reply/Send back/Retry controls are disabled. Real handoffs, assistant/error text and prompt detection need later producer phases. Session-wide permission grants, auto-approval, session boxes, caps and digests remain unimplemented; their endpoints are not exposed.
2. **High-risk bypass needs information missing from v1 summaries.** The Hub inspects each live gate once and infers display-only risk from its existing tool/input/path data using the spec's risky-operation categories. Inspections are bounded to four concurrent requests and cached by session lifetime/request ID. Failure to inspect is conservatively high-risk, not an approval. This does not add producer-owned risk fields, modify gate rules, enable automatic approval, or change OS notifications. The lexical hint is not a security parser and must not become an auto-approval authority.
3. **Breakthrough is per affected session.** Instead of flushing the whole pending snapshot when one high-risk gate appears, only that session is promoted/updated. Otherwise unrelated cards would move, violating Phase 1's frozen-board acceptance criterion.
4. **Cadence is page-anchored until Phase 5.** There is no session box yet, so the 25-minute clock starts when the page opens. Manual check-ins do not postpone it. Live is off again after a page reload.
5. **Acknowledgements have an optional freshness guard.** The browser also submits the displayed `lastAgentEnd`; stale stamps, active work, and pending permissions are rejected with 409. This prevents accepting an unseen newer completion after a frozen card is clicked. The documented `{id}` body remains supported. Permission decisions retain the existing required `requestId`, despite its omission from the spec's endpoint table.
6. **Additional UI/test files were necessary.** HTML/CSS implement the four-region layout. `hub-attention.ts` isolates classification/persistence and browser `board.ts` isolates freeze/ranking logic; the HTTP server serves the new browser module. These are implementation boundaries, not additional phases.

Phase 1 still intentionally misidentifies some idle sessions as Review, and metadata-only `lastActivity` changes can produce another unacknowledged return. Phase 2's real producer timestamps/signals are required to fix that reliably.

## Acceptance evidence

- Three live fixture sessions: idle with open todos → Needs you; mid-tool → Working; idle with completed todos → Review.
- Ordinary updates and a low-risk gate remain frozen. A high-risk `git push` gate enters Needs you without flushing the other pending changes.
- Clicking Allow once reaches the real permission broker's waiting owner callback. Existing integration tests also verify that broker decisions dismiss the actual Pi confirmation dialog. Persistent/session approval values remain rejected.
- Accept moves Review to Parked, survives a Hub restart, and does not acknowledge a later return. Persistence failure leaves the item unacknowledged.
- Manual refresh, Live toggle, 25-minute expiry, archive behavior, filtering, stable DOM/todo nodes, CSP/XSS defenses and mobile layout are tested in headless Chrome.

```sh
node --experimental-strip-types --test agent/tests/hub-attention.test.ts agent/tests/hub-board.test.ts agent/tests/pi-hub-web-*.test.ts agent/tests/hub-permissions*.test.ts
```

For the three-session desktop fixture:

```sh
PI_HUB_SCREENSHOT=/tmp/pi-hub-phase1.png node --experimental-strip-types --test agent/tests/pi-hub-web-order-browser.test.ts
```

Restart the existing bridge to load the new assets: `/hub-web stop`, then `/hub-web`. Other Pi sessions do not need new producer code.
