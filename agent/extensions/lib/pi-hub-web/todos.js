function createPanel(card) {
	const panel = document.createElement("details");
	panel.className = "todos";
	const summary = document.createElement("summary");
	summary.className = "todos-summary";
	const count = document.createElement("span");
	count.className = "todos-count";
	const current = document.createElement("span");
	current.className = "todo-current";
	summary.append(count, current);
	const list = document.createElement("ol");
	list.className = "todo-list";
	panel.append(summary, list);
	card.insertBefore(panel, card.querySelector(".card-bottom"));
	return panel;
}

/** Reuse the details element so live SSE refreshes retain each card's open state. */
export function renderTodos(card, todos) {
	let panel = card.querySelector(".todos");
	if (!todos?.total) {
		if (panel) panel.hidden = true;
		return;
	}
	panel ??= createPanel(card);
	panel.hidden = false;
	panel.querySelector(".todos-count").textContent = `Todos (${todos.completed}/${todos.total})`;
	panel.querySelector(".todo-current").textContent = todos.current ? ` - ${todos.current}` : "";
	const rows = todos.tasks.map((task) => {
		const row = document.createElement("li");
		row.dataset.status = task.status;
		const status = document.createElement("span");
		status.className = "todo-status";
		status.textContent = { completed: "✓", in_progress: "◐", pending: "○" }[task.status];
		status.setAttribute("aria-label", { completed: "Completed", in_progress: "In progress", pending: "Pending" }[task.status]);
		const subject = document.createElement("span");
		subject.className = "todo-subject";
		subject.textContent = task.subject;
		row.append(status, subject);
		return row;
	});
	if (todos.total > rows.length) {
		const more = document.createElement("li");
		more.className = "todo-more";
		more.textContent = `+${todos.total - rows.length} more tasks`;
		rows.push(more);
	}
	panel.querySelector(".todo-list").replaceChildren(...rows);
}
