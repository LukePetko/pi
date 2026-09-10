# Todos in Hub web

Each session with tasks gets a **Todos** disclosure on its Hub card. It starts collapsed:

```text
Todos (2/5) - Current todo name
```

Click the heading, or focus it and press Enter/Space, to expand the task list. Open state is independent for each card and survives live updates, sorting, and filtering. This browser state does not change the terminal widget. Sessions without a published task list have no Todos panel.

## Enable after updating

1. Run `/reload` in each Pi session whose todos should appear.
2. Restart an already-running dashboard with `/hub-web stop`, then `/hub-web`.

Task changes appear within about one second. No model request is made by the dashboard.

## Data flow and privacy

- `agent/extensions/todos-web.ts` publishes the current todo snapshot on session replay and successful `todo` tool results. It registers no new tool and does not alter task state.
- Only task IDs, subjects, and statuses are published. Descriptions, metadata, and conversation content are excluded.
- The private cache is under `~/.pi/agent/cache/hub-web/<scope>/todos/` (respecting `PI_CODING_AGENT_DIR` and Intercom scope). Files are mode `0600`; newly created directories are `0700`.
- Cache keys include the Intercom session identity and PID. Hub only attaches snapshots to matching live roster entries, and rejects snapshots older than that session's start (allowing five seconds for startup ordering).
- Snapshots are replaced atomically and removed on clean shutdown. Crashed sessions may leave ignored cache files; they are not displayed after leaving the live roster.
- Hub reads bounded task cache files, never opens session transcript files. Its existing loopback/token protection applies to the SSE snapshots.
- Payloads retain up to 200 rows and 256 characters per subject. Counts include the whole non-deleted list, and the browser indicates any omitted rows.

## Checks

```sh
node --test agent/tests/hub-todos.test.js agent/tests/todos-web-load.test.js agent/tests/pi-hub-web-todos-browser.test.js
```

The browser test uses real headless Chrome, exercises the cache-to-SSE-to-DOM flow, and checks disclosure clicks, keyboard activation, live updates, text-only rendering, terminal focus, and mobile width.
