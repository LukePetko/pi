# Permission requests in both Hubs

`confirm-dialog` requests are now shared with the terminal Hub and Hub web:

- The terminal `/hub` shows **Permission needed** in yellow and sorts waiting sessions first.
- Hub web shows the same yellow status, the complete request description, working directory, and full tool input. Long text scrolls rather than being silently truncated.
- **Allow once** or **Reject** resolves the original waiting request and dismisses the terminal dialog. A terminal decision also removes the web request.
- **Allow always** remains terminal-only, with its existing second confirmation. Hard-deny rules never create an approvable request.

## Activate and preview

1. Run `/reload` in the requesting Pi session and any Pi session displaying `/hub`.
2. Restart the existing dashboard: `/hub-web stop`, then `/hub-web`.
3. Run `/confirm-dialog test` in a Pi session. It previews `echo "Hello from Pi"`; **nothing executes**, regardless of your choice.
4. Open `/hub` from another session or view Hub web. The preview appears there until resolved.

This integration covers this repository's `confirm-dialog` permission gate, not unrelated question dialogs from other extensions. Headless requests retain the existing fail-closed behavior.

## Safety and lifetime

The pending decision and full payload live in the requesting Pi process. A private, authenticated loopback bridge exposes only inspection and one-time decisions; it cannot create requests or execute commands. Hub resolves the target from the current live roster, rather than accepting an arbitrary PID or endpoint.

Only request IDs/titles and private bridge metadata are cached under `agent/cache/hub-web/<scope>/permissions/`. New directories use `0700`, files use `0600`, and bridge credentials never appear in browser snapshots. Full tool inputs are not written to that cache.

Both UI paths consume the same random request ID. Duplicate, wrong-session, cancelled, reloaded, and already-resolved requests cannot be approved. Shutdown rejects remaining requests and closes the bridge. Browser approval is disabled if full details cannot be loaded; payloads over 1 MiB explicitly require terminal approval instead of showing a partial request.

The dashboard remains loopback-only. Approval endpoints require its bearer token, exact Origin, JSON body, and live request identity. Treat the Hub URL/token as an approval capability; do not share it. This is a trusted-local-user UI, not a sandbox against arbitrary code already running as your OS user.

## Checks

```sh
node --test agent/tests/hub-permissions.test.ts agent/tests/hub-permissions-browser.test.ts agent/tests/hub-permissions-load.test.ts
```

These cover real preview-to-Hub wiring, yellow terminal rendering, full browser details, native/browser synchronization, one-time decisions, forbidden persistent approvals, cross-origin/auth failures, large requests, and broker replacement cleanup.
