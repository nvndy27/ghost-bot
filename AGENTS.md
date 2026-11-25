# Engineering rules for all coding agents

- Read README, PRD, ARCHITECTURE, SECURITY, ROADMAP, PROVIDER_MATRIX, DESIGN_SYSTEM and relevant ADR before edits. Start with the first incomplete phase; do not jump ahead. Record decisions and actual results in docs/PROGRESS.md.
- Treat screenshots as the visual baseline. Preserve three-panel shell, compact sidebar, bottom composer controls, ChatGPT-like settings, two-eye SVG avatars and restrained neutral colors. No unrelated redesign or gradients by default. Support light/dark/system, keyboard and reduced motion.
- TypeScript strict, validate external data at boundaries (Zod when scaffolded), small typed modules, no direct provider calls from renderer, no secrets in logs, no unsafe HTML or unrestricted IPC. Use typed events and capability discovery; avoid duplicate runtimes and competing owners of state.
- Subscription-first but not subscription-only. Check current official docs and terms, cite URL/date/version in provider matrix. Never copy browser cookies or ask for account passwords. Use supported auth flows only. No silent API fallback, no invented quotas/models/efforts. If a provider cannot support subscription access, document it and use supported API only with consent.
- Separate provider/account/model/runtime. Model selector must reflect discovered capabilities. Permission modes must be enforced at actual execution boundaries; fail closed on unsupported mode, sandbox unavailable or approval timeout. Full Access is explicit, not default; sensitive external actions have separate approval. No root or unrestricted host bridge.
- Local-first; credentials in OS keyring or runtime-managed store. Use SQLite migrations, transactions and stable IDs; keep canonical ownership explicit. Redact secrets in event/audit logs. Do not persist hidden model reasoning.
- Prefer minimal vertical slices and real integration probes; avoid empty abstractions, unneeded frameworks or fake completion. Use fixtures explicitly labeled mock. Tests must not consume paid quota by default. Do not add dependencies without justification; commit lockfile when generated.
- Before concluding: run available lint/typecheck/tests, review security regressions, update roadmap and progress with evidence, report blockers and changed files. Never claim an untested integration works.

- Use the exact roadmap states Not Started, In Progress, Implemented, Tested, Verified and Blocked. Record the evidence and handoff in docs/PROGRESS.md, docs/KNOWN_ISSUES.md and docs/NEXT_STEPS.md. Keep reference screenshots local until their distribution rights are confirmed.

- After completing any task, include a short summary paragraph in the final response. State what changed, what was verified, and any remaining blocker. Keep the existing milestone handoff fields when applicable.

## GitHub issues and branches

- Track implementation work in GitHub Issues. Before starting, look for an existing issue and reuse it if it covers the work. An issue should describe the outcome, scope and acceptance criteria. When no issue exists, create one if authorized. For a small, directly requested change without an issue, record the scope in the PR or handoff.
- Start each issue or independently reviewable change on its own branch from the latest `origin/main`. Use `<type>/<issue-number>-<short-slug>`, for example `fix/42-approval-expiry`. For work without an issue use `<type>/<short-slug>`. Keep unrelated changes on separate branches and preserve other contributors' work.
- Make focused Conventional Commits. Review the diff, scan for secrets, run relevant checks, and push the working branch to the configured remote. Sync with `main` when needed. Never force-push or rewrite published history.
- Use a pull request targeting `main`. Include the outcome, test results and known limitations. Use `Closes #42` when merging fulfills that issue's acceptance criteria, or `Refs #42` for partial work. Keep `main` releasable and merge through the PR after required checks and review. Direct changes to `main` require explicit user direction.
- Keep the issue open while work or verification remains. Update its status when authorized and record the issue, branch, PR, commit, checks and blockers in the handoff as applicable.
