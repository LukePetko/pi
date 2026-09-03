---
name: personal-kb
description: Use this skill to read, search, update, or manage Lukas's global personal knowledge base at ~/.pi-knowledge. Trigger when the user says remember this, save to knowledge base, store this decision, what do I know about, search my notes, use my prior context, project memory, preferences, reusable snippets, or asks to sync knowledge between computers.
---

# Personal KB

The global knowledge base lives at:

```txt
/Users/lukaspetko/.pi-knowledge
```

It is Markdown-first and git-managed so it can be shared between machines.

## Principles

- Prefer reading/searching the KB automatically when it is clearly relevant.
- Only write when the user explicitly asks to remember/save/store something, or after asking for confirmation.
- Never silently overwrite useful existing knowledge.
- Prefer appending, creating a new focused file, or writing to `inbox/` when unsure.
- Keep notes concise, searchable, and file-path-citable.
- After writes, report changed file paths and suggest reviewing the diff.

## Layout

- `inbox/` — uncategorized captures and quick notes
- `notes/` — durable topic notes and personal preferences
- `projects/` — project-specific context and decisions
- `decisions/` — cross-project decisions
- `snippets/` — reusable code/config/workflow snippets
- `research/` — research summaries
- `templates/` — canonical templates
- `scripts/sync.sh` — git pull/commit/push helper

## Reading workflow

When the user asks about prior knowledge, preferences, previous decisions, or project context:

1. Search filenames and headings first.
2. Search file contents second.
3. Prefer project-specific notes when current working directory maps to a project.
4. Summarize findings with source file paths.
5. If nothing relevant exists, say so and optionally offer to create an entry.

Useful commands:

```bash
cd /Users/lukaspetko/.pi-knowledge
rg -n "query" notes projects decisions snippets research inbox
find projects notes decisions snippets research inbox -type f -name '*.md'
```

For broad or noisy output, use context-mode tools instead of raw Bash.

## Writing workflow

When saving knowledge:

1. Classify it:
   - project fact → `projects/<project>/context.md` or related file
   - decision → `projects/<project>/decisions.md` or `decisions/YYYY-MM-DD-topic.md`
   - reusable technical detail → `notes/<topic>.md`
   - command/code/config → `snippets/<topic>.md`
   - research → `research/<topic>.md`
   - unclear → `inbox/YYYY-MM-DD-brief-topic.md`
2. Use frontmatter from `templates/` for new files.
3. Include `created`, `updated`, `type`, and `tags` where practical.
4. Keep content factual; distinguish user preference, assumption, and verified fact.
5. Run or suggest `scripts/sync.sh` if the user wants sync.

## Sync workflow

To sync with git:

```bash
cd /Users/lukaspetko/.pi-knowledge
./scripts/sync.sh
```

If no remote exists, tell the user to create a private git repository and run:

```bash
git remote add origin <remote-url>
git push -u origin main
```

## Safety

- Do not store secrets, credentials, tokens, private keys, or passwords.
- Ask before storing sensitive personal/client information.
- Ask before deleting, renaming, or mass-rewriting KB content.
