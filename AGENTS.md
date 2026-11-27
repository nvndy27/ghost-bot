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

### Mandatory Completion Report

Every completed, partially completed, interrupted or blocked assignment must end with a self-contained, user-visible summary in the CLI's final response. Updating coordination files, GitHub comments or progress logs alone is insufficient. Never end a task with only a file reference or link.

The final report must include:

- Assignment and acceptance verdict.
- Completed implementation and important changes.
- Repository, branch, worktree and exact commit SHA.
- GitHub PR URL and publication status.
- Tests actually executed and their results.
- Untested functionality and remaining limitations.
- Security gates and unresolved blockers.
- Integration and cross-agent dependencies.
- Readiness for the next milestone.
- Exact recommended next action.

Clearly distinguish isolated module tests, integrated Electron acceptance and live verification. If blocked, give the exact blocker and required action before stopping. Do not silently wait, poll or repeat completed work. Keep reports concise and sufficiently complete for the maintainer to transfer directly to another AI session. Apply this rule after context compaction, session restoration or coding-agent migration.
