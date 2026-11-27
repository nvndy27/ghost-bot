# Shared baseline convergence

**Candidate inputs** — Main `3ce8c3f6f7dcc925461010dab1ffa0f729562e00`, Alpha.1A PR #20 `d7185c40298219d97290c982a1dcf49a6e7e6c8e`, Alpha.2AB PR #19 `c91ebcba34a9308ce5e3645417f5afaacd56e472`.

The merge preserves both draft histories. The shared IPC schema, Electron handlers and preload, daemon routes, and App wiring combine sidebar/session management with persisted workspace tabs, generation-bound personal read grants and Team Activity in Overview. The renderer refreshes workspace context after a persisted bot update changes its authorization generation. Both documentation histories are preserved. No migration or dependency changed.

Agent 2 accepted PR #19 for the scoped read-only integration in the local coordination handoff. Independent review of PR #20 and the combined candidate is pending.

## Combined evidence

Workspace lint, shared-types and desktop typechecks, and daemon and desktop builds passed. The focused Alpha.1A and daemon IPC suites passed 7/7. The two-launch combined Electron scenario passed against temporary data and the mock runtime. It checked provider changes, old grant rejection and clearing of the visible editor, file tree and read-only open, denied save with the file unchanged, Group Overview and denied group file access, switching sessions with an active run, and restart restoration of sidebar order, provider label, active conversation and Files tab. A valid grant before shutdown was absent after restart. The native chooser result was supplied by the Electron main test process. Zero live inference.

Run the combined scenario with `node scripts/verify-alpha1a-electron.mjs --shared-convergence` after building the desktop.

## Proposed Alpha.2C read-only Git interface

Maintainer approval is required before implementation. Agent 2 owns Git service and workspace UI. Agent 1 owns shared DTOs, daemon route registration and Electron IPC. Agree DTOs before shared edits. The separate search/preview proposal remains a distinct allocation decision.

- Reuse the daemon's personal bot grant, workspace ID, authorization generation and canonical repository containment. Keep group filesystem access gated.
- Expose typed branch, status, changed files, bounded diff and bounded history. Use daemon-issued references or validated workspace-relative paths. The client supplies no executable, flags, absolute paths or arbitrary revisions. Return explicit unavailable, stale and truncated states.
- Require fixed Git operations, sanitized environment and configuration, non-interactive execution, deadlines, output limits and cancellation. Disable helpers, hooks, external diff, textconv, fsmonitor, pagers, credential prompts, transports, and optional locks or refresh writes. Reject metadata outside the approved workspace, including external worktree metadata, alternates and recursive submodules. Fail closed where containment cannot be enforced.
- Stage, unstage, revert, fetch and other mutations stay gated.

## Write boundary

`/workspace/save` remains disabled. Other processes can change the target revision or substitute the staged directory entry before rename. Additional pre-rename checks and in-process serialization cannot make POSIX rename conditional on unchanged source and target entries. Explicit Ask Approval writes and Group task scope remain separate approval contracts.
