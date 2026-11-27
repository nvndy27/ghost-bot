# Alpha.0 Final Live Acceptance Report

Date: 2026-11-27
Candidate branch: `integration/alpha0-native-chat-rc`
Tested HEAD / Harness SHA: `22b3b167cbf4dc9e9cfb9851ac7f98730d867a7b`
Production code baseline: `6779ab358119b30017dce223729dfbfc68a98e15` (Draft PR #15 -> `main`)
Worktree: `/home/nguyenduy/Documents/Projects/ghost-bot-alpha0b`

## 1. Environment & Authorization Scope

- **Codex CLI**: `codex-cli 0.172.0`
- **Account / Profile**: Dedicated ChatGPT-authenticated profile (`$HOME/.config/ghost-bot/codex-profile`, `authMethod: 'chatgpt'`, no API-key fallback, zero paid API spend).
- **Discovered Model / Effort**: `gpt-6.2-sol`, effort `low`, `read-only` permission, isolated temporary `dataDir` and `workspaceDir` (cleaned up in `finally`).
- **Command executed (once)**: `GHOST_BOT_RUN_LIVE_CODEX=1 node scripts/verify-alpha0-live-codex.mjs`

## 2. Final Bounded 3-Prompt Live Results (`alpha0LiveAcceptance: "passed"`)

- **Total prompts consumed**: `3` (`MAX_TURNS_BUDGET = 3` strictly enforced; zero retries).
- **Prompt 1 (Streaming & persistence)**: `run_afca03dc-2aeb-448a-a86e-77e972fda9fd` — **`completed`**, `assistantReplyMatched: true` (`ALPHA0_OK`), `deltaEventCount: 4`, `terminalEvent: "run.completed"`, `usage: { inputTokens: 14992, outputTokens: 8, isMock: false }`.
- **Prompt 2 (Cancellation)**: `run_0dff4316-8292-4b95-9d9b-51501cd95fe3` — **`cancelled`**, `stopClicked: true`, `terminalEvent: "run.cancelled"`, `usage: "unavailable"` (cancellation does not guarantee zero upstream usage).
- **Prompt 3 (Restart continuity)**: Closed `app1`, relaunched `app2` against the same `dataDir`, verified identical `externalSessionId` (`externalThreadBound: true`), `resumable: true`, `quarantined: false`, and identical `accountId` across Prompt 1 / post-restart / Prompt 3 / final SQLite `sessions` row (`accountBindingVerified: true`). `run_490ca871-719f-45ee-bd84-88b38ec390b2` — **`completed`**, `assistantReplyMatched: true` (`ALPHA0_OK`), `deltaEventCount: 4`, `terminalEvent: "run.completed"`, `usage: { inputTokens: 15098, outputTokens: 8, isMock: false }`.
- **SQLite & Workspace integrity**: All 3 `runs` IDs matched IPC and SQLite (`completed`, `cancelled`, `completed`), all `permission_mode = 'read-only'`, and `workspaceIntact: true` (`sentinel.txt` unmodified).
- **Runtime usage windows**: `usageStatus: "available"`, `300m: 10%` (`resetAt: 2026-11-27T06:34:46.000Z`), `10080m: 30%` (`resetAt: 2026-11-30T19:01:30.000Z`).

## 3. Historical Previous Run (`6779ab3` / `fcf71c5`)

- The earlier 3-prompt run at `6779ab3` had passed Prompt 1 (`completed`) and restart UI restoration, with Prompt 3 interrupted by the pre-HARNESS-01 script wait race. The finalized `22b3b16` harness superseded that run cleanly with all 3 durable outcomes (`completed`, `cancelled`, `completed`) verified.

## 4. Independent Acceptance & Remaining Blockers

- **Agent 2 Security Review on PR #15**: Pending (`0` reviews posted on PR #15 at checkpoint time).
- **Agent 2 Packaging Verification (`AppImage` / `RPM` on Fedora GNOME / Ubuntu)**: Pending independent Agent 2 verification (test-only `--no-sandbox` Playwright launch does not substitute for packaged app acceptance).
- **Alpha.0 Live Gate Verdict**: **PASS (Live Codex Path)** / **CONDITIONAL PASS (Overall Alpha.0 Release)** pending Agent 2 independent security & packaging acceptance and owner-approved merge of PR #15 to `main`.
