import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTodos from "../npm/node_modules/@juicesharp/rpiv-todo/index.ts";

/** Use the upstream tool/shortcut/lifecycle with our tracked widget adapter. */
export default function todos(pi: ExtensionAPI): void {
	registerTodos(pi, () => import("./lib/todo-overlay.ts"));
}
