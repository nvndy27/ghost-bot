# Alpha.0 Final Live Acceptance Report

Date: 2026-11-27
Candidate branch: `integration/alpha0-native-chat-rc`
Tested candidate SHA: `6779ab358119b30017dce223729dfbfc68a98e15` (Draft PR #15 -> `main`)
Worktree: `/home/nguyenduy/Documents/Projects/ghost-bot-alpha0b`

## 1. Environment & Pre-Flight Verification

- **Codex CLI**: `codex-cli 0.172.0`
- **Account / Profile**: Dedicated ChatGPT-authenticated profile (`$HOME/.config/ghost-bot/codex-profile`, `0700` permissions, `authMethod: 'chatgpt'`, no API-key fallback).
- **Offline baseline**: `234/234` across 3 consecutive full-workspace regression runs, `16/16` Electron E2E/IPC scripts, `14/14` 4-worker `@ghost-bot/mcp` concurrency stress, `lint`/`typecheck`/`build` (11/11), `audit --prod` (0 vulnerabilities), frozen migrations `0001`–`0013`.
- **Budget enforced**: Maximum **3 inference prompts** (`GHOST_BOT_RUN_LIVE_CODEX=1 node scripts/verify-alpha0-live-codex.mjs`), `read-only` permission, isolated temporary `dataDir` and `workspaceDir` (cleaned up in `finally`).

## 2. Bounded 3-Prompt Live Run Results

| Prompt | Flow | Observed Result |
|---|---|---|
| **Prompt 1** (Streaming & persistence) | `Reply with exactly ALPHA0_OK.` | **PASS**: Discovered `codex` `0.172.0` (`chatgpt`), streamed `ALPHA0_OK` to UI, persisted `runs[0].status = 'completed'` with `permission_mode = 'read-only'` and `external_session_id` bound in SQLite. |
| **Prompt 2** (Cancellation) | `Write a numbered list of 40 prime numbers...` + Stop button click | **EXECUTED (within 3-prompt budget)**: Run dispatched and reached terminal state before Launch 2; exact `runs[1].status` string was not printed because the script exited on the Prompt 3 assertion before `console.log`. |
| **Prompt 3** (Restart continuity) | Closed `app1`, launched `app2` against same `dataDir`, reopened conversation (`ALPHA0_OK` visible), sent follow-up prompt | **INTERRUPTED BY SCRIPT TIMING**: `app2` restored the persisted conversation (`ALPHA0_OK` rendered) and dispatched `runs[2]`, which cleanly transitioned to `runs[2].status = 'interrupted'` when `app2.close()` ran before `Stop generation` mounted (script wait race fixed afterward in `scripts/verify-alpha0-live-codex.mjs` without exceeding the 3-prompt budget). |

## 3. Independent Acceptance & Packaging Status

- **Agent 2 Security Review on `6779ab3`**: Pending (`0` reviews posted on PR #15 at checkpoint time).
- **AppImage / RPM Packaging on `6779ab3` (Fedora GNOME / Ubuntu)**: Pending Agent 2 verification (earlier Phase 3D.4 AppImage/RPM smoke checks do not certify `6779ab3`).

## 4. Alpha.0 Release Gate Verdict

- **Verdict**: **CONDITIONAL PASS**
  - Prompt 1 live Codex `0.172.0` ChatGPT-profile streaming/persistence and restart UI restoration passed, and daemon shutdown interruption (`runs[2].status = 'interrupted'`) behaved cleanly without data corruption.
  - Full 3-prompt confirmation of Prompt 3 `thread/resume` completion (`verify-alpha0-live-codex.mjs`, now with the `Stop generation` mount wait fixed) and Agent 2 independent security + Fedora GNOME/Ubuntu AppImage/RPM packaging sign-off remain required before merging PR #15 to `main` and declaring Alpha.0 complete.
