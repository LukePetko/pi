# Collapsible todos

- Click the **Todos heading** in Pi fullscreen mode to collapse or expand it.
- **Ctrl+Shift+T** does the same in either TUI mode (the existing rpiv-todo shortcut).
- Wheel events are not consumed by the widget, so fullscreen transcript scrolling still works.
- Collapsed output is one row: `Todos (2/5) - Implement the widget`.
- The name is the in-progress task's subject, falling back to the first pending task, then the last completed task. Counts include all non-deleted tasks, including completed rows hidden by the expanded widget.
- Empty lists and completed-only lists retain upstream auto-hide behavior. Collapse state lasts for the current overlay lifetime; reload starts expanded.

Run `/reload` after installing or changing the adapter. `/todos` still prints the complete list.

## Implementation

`agent/extensions/todos.ts` registers the installed `@juicesharp/rpiv-todo` tool, command, shortcut, and lifecycle with a custom overlay importer. `agent/extensions/lib/todo-overlay.ts` subclasses its overlay and decorates only the widget component through `setWidget`; it does not patch package files or global UI methods.

The package remains installed, but its automatic extension entrypoint is disabled with `extensions: []` in `agent/settings.json`. The local entrypoint replaces it, preventing duplicate tool and shortcut registration.

This uses the overlay injection seam in rpiv-todo 2.9.0. After updating that package, run:

```sh
node --test agent/tests/todos.test.ts
```

The tests exercise rendering, click/shortcut interaction, width limits, session isolation, completed-task hiding, and real tool-to-overlay wiring through Pi's extension loader.
