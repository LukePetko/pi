# Permission requests in both Hubs

`confirm-dialog` requests are now shared with the terminal Hub and Hub web:

- The terminal `/hub` shows **Permission needed** in yellow and sorts waiting sessions first.
- macOS shows a separate **Permission needed** alert from **Pi Permissions**. **Accept once** approves only that request; **Reject** denies it; **Show** focuses Pi without deciding. Accept/Reject require unlocking the Mac. macOS may put these buttons under **Options**. Only the project name and permission title appear, not command arguments—use Show or Hub to inspect unfamiliar requests before approving.
- Hub web shows the same yellow status, the complete request description, working directory, and full tool input. Long text scrolls rather than being silently truncated.
- **Allow once** or **Reject** resolves the original waiting request and dismisses the terminal dialog. A terminal decision also removes the web request.
- **Allow always** remains terminal-only, with its existing second confirmation. Hard-deny rules never create an approvable request.

## Activate and preview

1. Run `/reload` in the requesting Pi session and any Pi session displaying `/hub`.
2. Restart the existing dashboard: `/hub-web stop`, then `/hub-web`.
3. Run `/confirm-dialog test` in a Pi session. It previews `echo "Hello from Pi"`; **nothing executes**, regardless of your choice.
4. Open `/hub` from another session or view Hub web. The preview appears there until resolved.

Allow notifications for **Pi Permissions** and select **Alerts/Persistent** in macOS System Settings. This is separate from **Pi Notifier**, which continues to handle completion notifications. The Swift helper builds locally on first use under `agent/cache/native-permissions/`; it needs Xcode Command Line Tools (`xcode-select --install`). No generated binaries are committed, and compilation/authorization never blocks the terminal permission dialog.

The native alert clears when you approve, reject, cancel, or resolve the request from Hub, and on session shutdown/reload. Both pending and delivered notification IDs are removed and checked; late delivery is cleaned up too. Its private callback record is revoked before removal. If the native helper is unavailable or denied notification access, the existing removable **Show**-only terminal-notifier alert is used. Its cleanup closes stdin explicitly: terminal-notifier otherwise waits indefinitely for EOF. Permission failures never use the non-removable AppleScript fallback.

This integration covers this repository's `confirm-dialog` permission gate, not unrelated question dialogs from other extensions. Headless requests retain the existing fail-closed behavior.

## Safety and lifetime

The pending decision and full payload live in the requesting Pi process. A private, authenticated loopback bridge exposes only inspection and one-time decisions; it cannot create requests or execute commands. Hub resolves the target from the current live roster, rather than accepting an arbitrary PID or endpoint.

Only request IDs/titles and private bridge metadata are cached under `agent/cache/hub-web/<scope>/permissions/`. New directories use `0700`, files use `0600`, and bridge credentials never appear in browser snapshots. Full tool inputs are not written to that cache.

Native actions use the same authenticated broker and request ID as Hub, not shell execution of the requested command. Private `0600` callback records contain process identity and routing metadata, but no broker token or tool input; only a random record ID reaches Notification Center. Recycled process IDs, removed records, and resolved requests fail closed. If the bridge cannot publish the request, the native notification offers **Show** only.

All UI paths consume the same random request ID. Duplicate, wrong-session, cancelled, reloaded, and already-resolved requests cannot be approved. Shutdown rejects remaining requests and closes the bridge. Browser approval is disabled if full details cannot be loaded; payloads over 1 MiB explicitly require terminal approval instead of showing a partial request.

The dashboard remains loopback-only. Approval endpoints require its bearer token, exact Origin, JSON body, and live request identity. Treat the Hub URL/token as an approval capability; do not share it. This is a trusted-local-user UI, not a sandbox against arbitrary code already running as your OS user.

## Checks

```sh
node --test agent/tests/hub-permissions.test.ts agent/tests/hub-permissions-browser.test.ts agent/tests/hub-permissions-load.test.ts agent/tests/permission-notifications.test.ts agent/tests/macos-notify-permissions.test.ts
```

These cover real preview-to-Hub wiring, yellow terminal rendering, full browser details, native/browser synchronization, one-time decisions, forbidden persistent approvals, cross-origin/auth failures, large requests, and broker replacement cleanup.

Native callback and race tests:

```sh
node --test agent/tests/native-permission-action.test.ts agent/tests/native-permission-notifications.test.ts
```

Opt-in macOS test (briefly posts harmless test alerts; allow Pi Permissions first):

```sh
PI_NATIVE_NOTIFICATION_TEST=1 node --test agent/tests/native-permission-app.test.ts
```

For manual button verification, run `/confirm-dialog test` once per action. Accept once and Reject should close the waiting dialog; Show should focus it without deciding. Approving from Hub or the terminal should remove the alert as well.
