# Global Agent Instructions

## Version control

- Always work inside a Git repository. If the current project is not a repository, initialize one before making project changes.
- Use small, coherent commits as checkpoints after each verified unit of work.
- Treat every repository other than the active repository as read-only unless the user explicitly instructs you to modify it.
- Push each commit in the active repository to its configured upstream remote immediately after creating it. If the push fails, report the failure before continuing.
- Before every push to a repository other than the active repository, ask the user for explicit permission. Permission to modify or commit does not imply permission to push.
- Commit only changes made for the current task. Never include, discard, overwrite, or amend unrelated user changes.
- Before committing, inspect the diff and run the relevant checks. Use clear commit messages describing the completed checkpoint.
