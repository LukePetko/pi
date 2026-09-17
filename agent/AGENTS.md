# Global Agent Instructions

## Version control

- Always work inside a Git repository. If the current project is not a repository, initialize one before making project changes.
- Commit frequently: create a checkpoint immediately after each small, verified, independently revertible change rather than waiting until the whole task is finished.
- Keep each commit focused on one logical change. Separate unrelated fixes, refactors, formatting, and configuration changes so each can be reverted without losing other work.
- For multi-step tasks, plan commit boundaries up front and commit each completed slice before starting the next. Keep a change and its necessary tests together; do not commit broken intermediate states.
- Treat every repository other than the active repository as read-only unless the user explicitly instructs you to modify it.
- Push each commit in the active repository to its configured upstream remote immediately after creating it. If the push fails, report the failure before continuing.
- Before every push to a repository other than the active repository, ask the user for explicit permission. Permission to modify or commit does not imply permission to push.
- Commit only changes made for the current task. Never include, discard, overwrite, or amend unrelated user changes.
- Before committing, inspect the diff and run the relevant checks. Use clear commit messages describing the completed checkpoint.
