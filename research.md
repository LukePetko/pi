# Research: Claude Code-style agent swarm/team markdown files

## Summary

Claude Code-style agent roles are commonly structured as Markdown files with YAML frontmatter for machine-readable metadata (`name`, `description`, tools/model/permissions) plus a Markdown body used as the role/system prompt. A Pi `/swarm` command that parses arbitrary Markdown headings into temporary roles is reasonable as a lightweight, user-friendly layer, but it should normalize those headings into explicit role objects and add guardrails for descriptions, capabilities, isolation, and coordination.

## Findings

1. **The dominant Claude Code subagent format is one role per Markdown file with YAML frontmatter plus a Markdown prompt body.** Official docs require `name` and `description`; optional fields include `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, MCP servers, hooks, memory, background execution, worktree isolation, and color. The body becomes the subagent system prompt. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents.md)

2. **Capabilities are a first-class part of the role definition, not just prose.** Claude Code uses tool allowlists/denylists, model selection, permission modes, hooks, scoped MCP servers, persistent memory, and worktree isolation to constrain or specialize agents. This suggests Pi should avoid treating headings as complete roles unless it can infer or ask for safe defaults such as read-only, write-capable, reviewer, researcher, or implementer. [Claude Code subagents](https://code.claude.com/docs/en/sub-agents.md)

3. **Agent teams differ from subagents by adding independent sessions, direct messaging, a shared task list, and coordination overhead.** Claude’s team docs recommend teams for parallel research/review, competing hypotheses, and cross-layer work, but warn about higher token cost, file conflicts, and diminishing returns; 3–5 teammates is the practical starting range. [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams.md)

4. **Reusable teammate roles can be backed by subagent definitions.** Claude Code lets teams spawn teammates “using” a subagent type; the teammate honors the subagent’s `tools` and `model`, while the Markdown body is appended as extra instructions. This supports Pi’s idea of temporary roles generated from a Markdown team spec, as long as the resulting roles map to concrete runtime fields. [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams.md)

5. **Slash/custom command files are also Markdown-driven prompts.** Claude Code custom commands live under `.claude/commands/`, use Markdown with YAML frontmatter such as `description` and `allowed-tools`, and can receive arguments. This is a strong precedent for a `/swarm` command that interprets a Markdown document as executable orchestration instructions. [Claude Code commands](https://code.claude.com/docs/en/commands)

6. **AGENTS.md shows the ecosystem accepts free-form Markdown headings for agent guidance, but not necessarily for role/capability definitions.** The AGENTS.md format intentionally has no required fields and uses arbitrary headings for project setup, tests, style, and security instructions. That argues for accepting arbitrary Markdown as input, but also for compiling it into a stricter internal schema before launching agents. [AGENTS.md](https://agents.md/)

## Recommendations for Pi `/swarm`

- Accept arbitrary Markdown headings as a convenience, but compile them into temporary role records: `name`, `description/when_to_use`, `prompt`, `tools/capability preset`, `model/effort`, `write_policy`, `coordination_mode`, and `deliverable`.
- Support an optional YAML block per heading for power users; otherwise infer safe defaults from heading names and text. Example presets: `research` = web/read-only, `review` = read-only, `implement` = edit-enabled, `qa` = test/bash-limited.
- Validate before launch: unique role names, no empty prompts, explicit write permission for any role that can edit, max team size defaults, and conflict detection when multiple agents may edit the same files.
- Add orchestration semantics beyond roles: shared objective, task list, dependencies, synthesis step, stop criteria, and final report format.
- Prefer temporary agents for ad-hoc brainstorming/review swarms; encourage saved Markdown/YAML role files for reusable teams.

## Sources

- Kept: Claude Code subagents (https://code.claude.com/docs/en/sub-agents.md) — primary source for Markdown+frontmatter role structure and capability fields.
- Kept: Claude Code agent teams (https://code.claude.com/docs/en/agent-teams.md) — primary source for swarm/team behavior, coordination, and limitations.
- Kept: Claude Code commands (https://code.claude.com/docs/en/commands) — primary source showing Markdown-backed slash command precedent.
- Kept: AGENTS.md (https://agents.md/) — ecosystem precedent for arbitrary Markdown headings as agent-facing guidance.
- Dropped: third-party Claude subagent guides — useful examples but redundant with official docs.
- Dropped: SEO-style custom command tutorials — redundant with official command docs.

## Gaps

I did not find a widely adopted standard specifically for “team markdown” where arbitrary headings directly instantiate multi-agent swarms. The closest patterns are Claude Code subagent files, Claude agent teams using subagent definitions, custom command Markdown prompts, and free-form AGENTS.md guidance. Next step: prototype a permissive parser plus a strict internal schema and test it against real team-spec examples.
