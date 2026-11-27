# Alpha.0 Final Live Acceptance Report

Date: 2026-11-27
Candidate branch: `integration/alpha0-native-chat-rc`
Previously live-tested production candidate: `6779ab358119b30017dce223729dfbfc68a98e15` (Draft PR #15 -> `main`)
Worktree: `/home/nguyenduy/Documents/Projects/ghost-bot-alpha0b`

## 1. Preserved Previous Bounded Live Results (`6779ab3`, 3 Prompts Exhausted)

- **Prompt 1 (Streaming & persistence)**: **PASS** (`runs[0].status = 'completed'`, `ALPHA0_OK` streamed and persisted with `permission_mode = 'read-only'` and `external_session_id` bound in SQLite).
- **Prompt 2 (Cancellation)**: **Executed, exact terminal outcome not established** (the script exited on Prompt 3's assertion before printing `runs[1].status`, and temporary dirs were cleaned up in `finally`; no additional per-run artifacts are recoverable).
- **Restart UI restoration**: **PASS** (`app2` reopened the persisted conversation and rendered `ALPHA0_OK`).
- **Prompt 3 (Thread continuity)**: **Interrupted by acceptance script timing** (`runs[2]` cleanly transitioned to `'interrupted'` when `app2.close()` fired before `Stop generation` mounted).
- **Overall previous live verdict**: **CONDITIONAL PASS** (3-prompt budget exhausted; **0** additional live prompts consumed during harness finalization).

## 2. Acceptance Harness Finalization (`LIVE ACCEPTANCE HARNESS READY`)

Refactored `scripts/verify-alpha0-live-codex.mjs` and verified offline in `tests/alpha0-live-harness.test.ts` (zero live inference):

1. Polls `window.ghostBot.listMessages({ sessionId })` to capture each newly created `runId` (handling delayed run creation) and polls `window.ghostBot.getRun(runId)` until a durable terminal status (`completed`, `failed`, `cancelled`, `interrupted`) is reached—eliminating Stop-button disappearance as a completion heuristic.
2. Requires Prompt 2's durable terminal status to be strictly `'cancelled'` (a fast `'completed'` Prompt 2 fails as `Cancellation not verified`).
3. Verifies assistant-only message content (`extractAssistantTextForRun`, never matching user prompt text).
4. Verifies `externalSessionId` and `accountId` persist identically across Electron/daemon restart (`inspectSession`).
5. Requires Prompt 3's durable terminal status to be `'completed'` with `ALPHA0_OK` in its assistant reply.
6. Preserves `usage.updated` metadata where available and explicitly labels `'unavailable'` when absent.
7. Emits sanitized per-run JSON evidence in `finally` **before** deleting temporary `dataDir` / `workspaceDir`, even when assertions fail.
8. Enforces `MAX_TURNS_BUDGET = 3` via `createTurnBudgetTracker(3)` with zero automatic retries, plus `GHOST_BOT_RUN_LIVE_CODEX === '1'` opt-in guard.
9. Verifies read-only `sentinel.txt` and workspace integrity.
10. Preserves production `sandbox: true` in `apps/desktop/electron/main.ts` (`--no-sandbox` remains a test-only headless Playwright launch flag and is not packaged-app acceptance).

## 3. Agent 2 Independent Acceptance Status

- **PR #15 GitHub reviews/comments**: `0` reviews posted on `6779ab3` / `8604a32`.
- **Security & AppImage/RPM Packaging on current candidate**: Pending Agent 2 independent verification on Fedora GNOME (primary) / Ubuntu (secondary).

## 4. Corrected Final Live Acceptance Procedure & Authorization Request

Pending explicit fresh owner authorization for a maximum of **3 additional Codex prompts**:

```bash
cd /home/nguyenduy/Documents/Projects/ghost-bot-alpha0b
GHOST_BOT_RUN_LIVE_CODEX=1 node scripts/verify-alpha0-live-codex.mjs
```

- **Scope**: Official Codex App Server `0.172.0` only, dedicated ChatGPT profile (`$HOME/.config/ghost-bot/codex-profile`), `read-only` permission, isolated temp `dataDir` and `workspaceDir`, no API-key fallback, no other live provider, no software installation or host configuration changes.
- **Pass gate**: Prompt 1 `completed` (`ALPHA0_OK` assistant reply), Prompt 2 `cancelled`, restart thread/account continuity preserved, Prompt 3 `completed` (`ALPHA0_OK` assistant reply), sentinel intact, plus Agent 2 security and packaging sign-off.
