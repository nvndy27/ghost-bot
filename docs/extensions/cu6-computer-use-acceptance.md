# CU.6: Final Computer Use Production Acceptance

- **Branch**: `feat/cu6-computer-use-acceptance` (branched from `20c163d6e22452f9b4ea52d7472d9b4bb66b5354`)
- **Migrations**: `0001`–`0012` preserved unchanged.
- **Zero live inference, external browsing, host desktop access, or `sudo` used.**

## 1. Confirmed Findings and Fixes
- **`CU4-RUN-01` (Closed & Tightened in CU.6)**:
  - Restricted `PERMITTED_CU_RUN_STATES` in `apps/daemon/src/computer-use/service.ts` to `new Set(['running'])`, ensuring `queued`, `awaiting_approval`, `cancelling`, `completed`, `failed`, and `interrupted` runs cannot create or execute Computer Use sessions.
  - Added `revalidateAuthority(...)` revalidating active unarchived bot, bot permission policy, authoritative `runs` row (`agent_id`, `status === 'running'`, `permission_mode` policy), unarchived parent `sessions` row, and active `cu_sessions` + worker identity at session creation, worker startup steps (`start`, `createSession`, `openTab`), `observeTab`, `requestActionApproval`, `resolveActionApproval`, `executeAction` (pre-consumption), and immediately prior to `worker.executeBatch(...)` dispatch.
  - Wired `RunOrchestrator.setOnRunTerminated(...)` -> `ComputerUseService.revokeByRunId(...)` so parent run cancellation/finalization revokes outstanding CU sessions and approvals.
  - Closed startup and dispatch cancellation races in `BwrapIsolatedBrowserWorker.start()`/`emergencyStop()` and `ComputerUseService.executeAction()`, preserving `uncertain` / `interrupted` outcomes on unconfirmed termination and blocking late callbacks or automatic replay (`replayAllowed: false`).
- **`CU4-PKG-03` (Closed)**:
  - Fixed esbuild banner collision in `apps/desktop/scripts/bundle-daemon.mjs` (`import { createRequire as __ghostCreateRequire } from 'node:module'; const require = __ghostCreateRequire(import.meta.url);`).
- **Bounded Resources (`CU.6` Hardening)**:
  - Enforced `MAX_ACTIVE_CU_SESSIONS = 4` in `ComputerUseService.createSession()` (`CU_SESSION_LIMIT_REACHED`, HTTP `429`) and `MAX_PENDING_RPC = 32` in `BwrapIsolatedBrowserWorker.call()`.

## 2. CU4-RUN-01, CU4-PKG-02, and CU4-PKG-03 Closure Evidence
- **CU4-RUN-01**: Independently accepted on `20c163d` and extended in `tests/cu6-computer-use-acceptance.test.ts` (4/4 passing): verifies rejection of `queued`, `awaiting_approval`, `cancelling`, `completed`, `failed`, and `interrupted` runs; permission downgrade to `read-only`; parent session archival; unconfirmed emergency-stop (`confirmed: false` -> `interrupted` + `uncertain`); late callback rejection; and `MAX_ACTIVE_CU_SESSIONS = 4` bounds.
- **CU4-PKG-03**: Verified `apps/desktop/dist-daemon/daemon.mjs` (`tests/cu4-hardening-acceptance.test.ts`), extracted AppImage `squashfs-root/resources/daemon/daemon.mjs`, and extracted RPM `/opt/GhostBot/resources/daemon/daemon.mjs` all start cleanly without `SyntaxError`, authenticate, discover capabilities, create isolated `bwrap` browser sessions, navigate synthetic fixtures, capture PNG screenshots, and confirm emergency stop.
- **CU4-PKG-02**: Packaged worker (`computer-use-worker.mjs`) and vendored `playwright-core` resolve inside extracted AppImage and RPM without workspace paths; host `node` and `bwrap` availability are explicitly probed, failing closed when absent.

## 3. Actual Approval and Browser Interaction Evidence
- Verified via `scripts/verify-cu5-computer-use-desktop.mjs`, `tests/cu4-computer-use-production.test.ts`, and `tests/cu4-hardening-acceptance.test.ts` against synthetic local fixtures inside `bwrap`:
  - Approved `navigate`, `type_text`, `click_selector`, and `scroll` execute with single-use approval consumption.
  - Denied actions (`CU_APPROVAL_DENIED`) do not execute.
  - Duplicate approval consumption, expired/revoked approvals, action hash mismatch, navigation-generation mismatch, stale observations, cross-session/cross-tab mismatches, inherited Teams/Scheduler consent (`CU_INHERITED_CONSENT_FORBIDDEN`), and `read-only` mutation (`CU_READ_ONLY_BLOCKS_MUTATION`) are rejected.
  - Typed-text secrets are redacted in `cu_action_ledger` (`[REDACTED len=...]`); screenshots are not persisted or logged.

## 4. Live Viewer Transport Verification
- Verified via `scripts/verify-cu5-computer-use-desktop.mjs` and `tests/cu5-computer-use-hardening.test.ts`:
  - Enforces `<= 2 FPS` polling, `<= 2 MiB` decoded PNG limit (`MAX_OBSERVATION_BYTES`), monotonic `frameSeq`, valid PNG dimensions and SHA-256, single-flight `observeInFlight`, backpressure drop counting (`backpressureDropCount`), stale-frame bypass on navigation generation change, polling stop on modal close, session/tab switching, and `mapScreenshotPointToViewport(...)` preview-only mapping without `<webview>` or `<iframe>`.

## 5. Containment and Process Lifecycle Evidence
- Verified via `@ghost-bot/computer-use` (16/16), `tests/cu4-computer-use-production.test.ts`, `tests/cu5-computer-use-hardening.test.ts`, and `tests/cu6-computer-use-acceptance.test.ts`:
  - Composed Bubblewrap (`--unshare-all --die-with-parent --new-session --cap-drop ALL`) + Chromium (`chromiumSandbox: true`, no `--no-sandbox`) containment with synthetic filesystem and TCP canary denial.
  - Bounded RPC framing (`4 MiB`), continuous stderr draining, startup failure/timeout handling, unexpected worker exit rejection, restart reconciliation without replay, private workspace cleanup, and `hostDesktopControlSupported: false`, `frameCaptureSupported: false`, `inputInjectionSupported: false`, `liveModelDrivenEnabled: false`.

## 6. Packaging Verification Matrix
| Artifact / Mode | Status | Evidence |
|---|---|---|
| Package Build (AppImage + RPM) | **Verified** | `electron-builder` AppImage + `dir` + `scripts/build-rpm.mjs` built `GhostBot-0.1.0-x86_64.AppImage` and `ghost-bot-0.1.0-1.x86_64.rpm` |
| Extracted Worker Execution | **Verified** | `computer-use-worker.mjs` + `vendor/playwright-core` inside `bwrap` |
| Extracted AppImage Daemon Execution | **Verified** | `squashfs-root/resources/daemon/daemon.mjs`: capabilities, isolated session, navigate, 9,077-byte PNG, emergency stop |
| Extracted RPM Daemon Execution | **Verified** | `rpm2cpio` + `cpio` `/opt/GhostBot/resources/daemon/daemon.mjs`: capabilities, isolated session, navigate, 9,077-byte PNG, emergency stop |
| Full Packaged Electron UI-to-Daemon-to-Worker E2E | **Verified** | Launched `squashfs-root/@ghost-botdesktop`: Settings → Computer Use → consent → Start Session → Live Viewer PNG → Emergency Stop confirmed |
| Native AppImage Direct Execution (FUSE/mount) | **Not Verified** | Tested via `--appimage-extract`; direct FUSE mount not run |
| Installed RPM Execution (`dnf`/`rpm -i`) | **Not Verified** | Requires `sudo`/system install; verified via `rpm2cpio` extraction instead |

## 7. Exact Regression Counts
- `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build`: **PASS** (11/11 projects).
- **3 consecutive full-workspace regression runs** (**206/206** per run, 0 failed, 0 skipped):
  - `root` (`tests/*.test.ts`): **113/113**
  - `@ghost-bot/teams`: **20/20**
  - `@ghost-bot/scheduler`: **17/17**
  - `@ghost-bot/computer-use`: **16/16**
  - `@ghost-bot/memory`: **14/14**
  - `@ghost-bot/knowledge`: **12/12**
  - `@ghost-bot/mcp`: **14/14**
- **Electron E2E & IPC scripts**: `verify-cu4-computer-use-ipc.mjs`, `verify-cu5-computer-use-desktop.mjs`, `verify-phase-5b-scheduler-ipc.mjs`, `verify-phase-5c-routines-desktop.mjs`, `verify-phase-4d3-teams-acceptance.mjs`, `verify-phase-2e-acceptance.mjs` **PASS**.
- **MCP concurrency stress (4 parallel workers)**: **PASS**.

## 8. Independent Harness Compatibility
- External harnesses in `~/Documents/Projects/ghost-bot-security-lab/cu4/harnesses/` were left untouched and reference hardcoded `/tmp/ghost-bot-cu4-res-6c72fce`.
- Reproducible in-repo artifact paths and equivalent local production regression tests are provided in `tests/cu4-hardening-acceptance.test.ts` and `tests/cu6-computer-use-acceptance.test.ts`, using `apps/desktop/dist-daemon/daemon.mjs` and `apps/desktop/dist-daemon/computer-use-worker.mjs` generated by `corepack pnpm --filter @ghost-bot/desktop build`.

## 9. Remaining Release Limitations
- Host `node` and `bwrap` prerequisites on target Linux systems (`CU4-PKG-02`).
- Native FUSE AppImage execution and installed RPM (`dnf`/`rpm -i`) execution remain unverified.
- Live model-driven Computer Use, host desktop control, and virtual desktop frame/input remain disabled.

## 10. Roadmap Gap Analysis (`PRD.md`, `ROADMAP.md`, `PROVIDER_MATRIX.md`, `ARCHITECTURE.md`)
- **Offline Verified**: Phase 0–2 desktop/daemon/Codex/SQLite/approvals/recovery; Phase 3D.1–3D.3 Memory, Knowledge, local STDIO MCP; Phase 4D Teams; Phase 5B–5D Scheduler/Routines; CU.4–CU.6 Isolated Browser & Live Viewer.
- **Live Verified**: Codex App Server (`plus` profile) streaming, approvals, and recovery (Phase 2B–2D).
- **Gated**: Live Teams execution (`LIVE_TEAMS_GATED`), live Scheduler autonomous inference, live model-driven Computer Use, OpenClaw Gateway execution (`Metadata Verified / Execution Gated`), native Codex MCP (`unsupported_native_mcp`), headless Weston Virtual Desktop capture/input (`frameCaptureSupported: false`).
- **Incomplete**: OS Secret Service keyring for MCP `secretRefs`; skills, terminal (`xterm.js`/`node-pty`) and diff/patch viewer; Phase 6 (meeting assistant, mobile companion, remote gateway, marketplace, Windows/macOS).
- **Blocked**: Anthropic Claude subscription login (vendor approval required), Moonshot Kimi Code (`kimi` CLI unavailable locally), Ollama live probe (no local listener at `127.0.0.1:11434`).
- **Not Started**: Google Gemini API/enterprise opt-in, LM Studio / llama.cpp / OpenRouter adapters.

## 11. Commit Hash & Push Status
- Recorded on branch `feat/cu6-computer-use-acceptance` (pushed to `origin/feat/cu6-computer-use-acceptance`; not merged into `main`).

## 12. Final Offline Acceptance Verdict
- **ACCEPTED — Offline Computer Use Production Candidate** (with `CU4-RUN-01` and `CU4-PKG-03` closed, packaged Electron UI + extracted AppImage/RPM daemon verification passing, 206/206 across 3 consecutive runs, and 6/6 Electron E2E/IPC scripts passing).

## 13. Recommended Next Implementation Phase
- **Phase 3/5 Security & Core Completion**: Implement OS Secret Service keyring integration for MCP `secretRefs` and scoped skill/terminal execution with policy-preserving audit, or gated live-inference acceptance for Teams/Routines once explicitly authorized.
