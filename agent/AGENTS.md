# Global Agent Instructions

## Feature delivery and evidence

- Optimize for useful, verifiable outcomes and accurate recognition of the work, not activity counts or leaderboard points. Stay within the requested scope; do not invent features to increase a score.
- Before nontrivial implementation, state the observable behavior change, acceptance criteria, and smallest coherent increment that can be reviewed and safely integrated. Prefer completing existing work over starting unrelated parallel work.
- Slice work by independently useful behavior, not by file, layer, ticket, or commit count. Keep a feature's necessary implementation, contract changes, tests, and documentation together; separate unrelated maintenance, refactors, and migrations. Do not artificially split one outcome or bundle unrelated work to influence classification.
- For behavior changes, add or update meaningful automated tests in the same logical change, covering relevant failure modes and compatibility. Use the repository's test conventions, run relevant checks, and report exactly what passed, failed, or could not run. If automated coverage is impractical, explain why and provide reproducible validation steps; never add token tests just for recognition.
- Carry an agreed feature through every necessary layer, including interfaces, persistence, UI, and integration where relevant. Do not add layers, files, lines, or public interfaces solely to increase apparent size or reach.
- Make commit/MR descriptions and final handoffs evidence-based: describe the capability or improvement, why its changes form one outcome, implementation/test paths, validation results, and remaining integration blockers. For cross-repository work, identify related changes and safe landing order without exceeding repository permissions.
- Prefer short-lived, reviewable branches and surface review or integration blockers early. Follow repository review and release safeguards: permission to commit or push is not permission to merge, deploy, or bypass checks. Distinguish implemented, tested, merged, and deployed states; never call unmerged work shipped.
- Preserve truthful authorship and credit collaborators. Do not rewrite attribution, exclude collaboration, pad diffs, create empty activity, or change branch timing to manipulate ownership or freshness metrics.
- Treat missing feature mappings, pending classification, and contradictory metrics as evidence issues to flag for reassessment, not reasons to modify correct code. Keep necessary upkeep, research, reviews, and support visible even when a feature-delivery score excludes them; do not deprioritize them without agreement.

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
