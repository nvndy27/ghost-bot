# Alpha.0B: Integrated Native Chat Release Candidate (`v0.1 Personal & Friends Alpha` — Alpha.0)

Date: 2026-11-27
Branch: `integration/alpha0-native-chat-rc`
Base commit: `fec34fcf37822244dfbb859eacb934d390de5f29` (`feat/alpha0a-native-chat-closure`, PR #14)

## 1. Integration Ancestry & PR Convergence

All technical milestones from `origin/main` (`07839ff`) through `fec34fc` are direct ancestors of `integration/alpha0-native-chat-rc`:

- **Core & Extensions**: `538ee75`–`9b6ba1b` (Knowledge), `4553e0e`–`04e324c` (MCP), `a475033` (Phase 3D.4), `1ab25bc`–`f5dc1e9` (Teams 4A–4D.3), `a2288ab`–`e46dd67` (Scheduler/Routines 5A–5D), `b025d49`–`e1b9233` (Computer Use CU.1–CU.6), `def38d3` (Core.1 OS Secret Service), `ddc97fc` (Core.2 Scoped Terminal & Local Skills).
- **Providers & Hardening**:
  - PR #6 (`d6436c6`, `feat/provider1-openclaw-execution`): OpenClaw Gateway adapter & probe.
  - PR #7 (`94a71dc`, `feat/provider2-ollama-local`): Ollama local adapter & policy gate.
  - `edfbad1` + PR #8 (`fcded26`, `feat/provider3-claude-api`): `CORE2-TERM-01` / `CORE1-SS-01` + Claude API adapter.
  - PR #9 (`c65a621`, `feat/provider4-gemini-api`): Google Gemini API adapter.
  - `42b708b` + PR #10 (`d13e686`, `feat/provider5-kimi-acp`): Shared provider security + Kimi Code ACP adapter.
  - PR #11 (`5d57c39`, `feat/provider6-openai-compatible`): Shared OpenAI-compatible transport (`lmstudio`, `llamacpp`, `openrouter`).
  - PR #13 (`0291693`, `feat/provider7-unified-execution`): Unified multi-provider execution + Provider.6 residuals.
  - PR #14 (`fec34fc`, `feat/alpha0a-native-chat-closure`): Alpha.0A native Chat consistency, atomic preflight/dispatch barriers, structured canonical history role separation, and daemon-path coverage.
- **Documentation Reconciliation**:
  - PR #12 (`1802b0af` + `d4d5dbd`, `docs/v0.1-personal-friends-alpha`, branched from `5d57c39`): Full owner-approved `README.md`, `docs/ROADMAP.md`, `docs/NEXT_STEPS.md`, `docs/KNOWN_ISSUES.md`, and `docs/PROGRESS.md` reconciled onto `integration/alpha0-native-chat-rc` while preserving Provider.7 and Alpha.0A evidence.

**Frozen migrations**: `0001`–`0013` (`apps/daemon/src/db/migrations.ts`, `apps/daemon/src/db/schema.ts`) are byte-for-byte unchanged since `ddc97fc`.

## 2. Review Closure & Findings Status

- **PR #13 & PR #14 GitHub reviews/comments**: `0` external review comments posted on GitHub at inspection time.
- **Alpha.0A Findings (A0-01 – A0-06)** at `fec34fc`: All 6 resolved with deterministic unit/daemon/barrier/E2E evidence (see [Alpha.0A report](alpha0a-native-chat-closure.md)).
- **Remaining non-Alpha.0 items**: Live inference verification (Codex & optional local/API opt-in), Agent 2 independent security/packaging acceptance, and Alpha.1/Alpha.2 implementation.

## 3. Authoritative Provider & Capability Acceptance Matrix

| Runtime | Implemented | Protocol Fixture Tested | Daemon Execution Tested | Electron Production-Path Tested | Actual Runtime Verified | Live Inference Verified | Gated / Unavailable & Limitations |
|---|---|---|---|---|---|---|---|
| `codex` | Yes | Yes | Yes | Yes | CLI `0.172.0` | Previously verified (Phase 2) | `full-access` disabled; `unsupported_native_mcp`; ChatGPT `plus` profile |
| `lmstudio` | Yes | Yes | Yes (`GhostBotDaemon`) | Yes (`verify-provider7-unified-execution-desktop.mjs`) | No (host binary absent) | No | Loopback only; `read-only` tool-free; `efforts: []`; explicit opt-in per endpoint |
| `llamacpp` | Yes | Yes | Yes (`GhostBotDaemon`) | Settings/Bot UI only | No (host binary absent) | No | Loopback only; `read-only` tool-free; `efforts: []`; explicit opt-in per endpoint |
| `openrouter` | Yes | Yes | Yes (synthetic `transport`) | Settings/Bot UI + gated denial | No | No | Live API gated; `allow_fallbacks: false`; single account (`default`); `read-only`; `efforts: []` |
| `claude-api` | Yes | Yes | Yes (synthetic `transport`) | Settings/Bot UI only | CLI `2.1.331` read-only assessed | No | Live API gated; single account (`default`); `read-only`; `efforts: []`; no subscription token proxying |
| `gemini-api` | Yes | Yes | Yes (synthetic `transport`) | Settings/Bot UI only | No (`gemini` CLI absent) | No | Live API gated; single account (`default`); `read-only`; `efforts: []` |
| `ollama` | Yes | Yes | `RunOrchestrator` with direct test policy override only (`DaemonServer` gate closed) | Settings/Bot UI only | No (host binary/daemon absent) | No | **Gated in `DaemonServer`** (`ollamaExecutionAuthorized: false`); local-only; `read-only`; `efforts: []` |
| `openclaw` | Yes | Yes | Fail-closed `403` only | Settings/Bot UI only | CLI `2026.11.8` `operator.read` | No | **Execution Gated** until Gateway sandbox/billing verified |
| `kimi-acp` | Yes | Yes | Fail-closed `403` only | Settings/Bot UI only | No (`kimi` CLI absent) | No | **Execution Gated**; `fs/*` & `terminal/*` disabled |

## 4. Agent 2 Packaging & Security Handoff

- **Candidate branch / SHA**: `integration/alpha0-native-chat-rc` (recorded in PR #15 / final report).
- **Primary validation target**: Fedora GNOME (x86_64). Secondary target: Ubuntu. Windows is not claimed without platform-specific testing.
- **Packaging scope**: Verify `corepack pnpm package:appimage` (`APPIMAGE_EXTRACT_AND_RUN=1` 2-launch smoke) and `corepack pnpm package:rpm` (extracted RPM smoke check, zero credentials/DB bundled), plus independent security audit of PRs #6–#14 + Alpha.0B.
- **Production sandbox**: `apps/desktop/electron/main.ts` retains `sandbox: true`; `--no-sandbox` is restricted to headless test scripts and is not production evidence.

## 5. Bounded Live Acceptance Authorization Request (Next Step)

1. **Primary Required Check (Codex App Server)**:
   - **Runtime / Account**: `codex` using dedicated ChatGPT `plus` profile (`CODEX_HOME="$HOME/.config/ghost-bot/codex-profile"`).
   - **Prerequisites**: Installed Codex CLI `0.172.0`, authenticated session (`account/read` connected, no API key fallback).
   - **Bounds**: Maximum **3 prompts** (`read-only` turn + streaming, `turn/interrupt` cancellation, and `thread/resume` across restart) in an isolated temp workspace.
   - **Evidence**: Streaming deltas, single terminal outcome per run, restart continuity, and usage snapshot.
   - **Stop / Cleanup**: Abort on unexpected rate-limit spike, error, or auth prompt; delete temp workspace/DB after verification.
2. **Optional Second-Provider Check** (only if explicitly authorized):
   - Either local Ollama/LM Studio (`<= 2` prompts on local model, zero paid spend) OR opt-in OpenRouter/Claude/Gemini (`<= 2` prompts, `max_tokens <= 256`, user-supplied API key deleted afterward).

## 6. Alpha.1 / Alpha.2 Shared Contract Handoff (Planning Only)

- **Reuse existing entities**: `agents`, `sessions`, `runs`, `run_events`, `messages`, `approvals`, `teams`, `team_runs`, `team_tasks`, `TeamsService`, `TeamsExecutionBridge`. Do not introduce a second team engine.
- **Single-Owner Coordination**:
  - `packages/shared-types/ipc.ts` (shared IPC schemas): **Single coordinated owner**
  - `apps/daemon/src/server.ts` (daemon routes): **Single coordinated owner**
  - `apps/desktop/electron/main.ts` & `preload.cts`: **Single coordinated owner**
  - `apps/desktop/src/App.tsx` (three-panel shell & tab/sidebar integration): **Single coordinated owner**
  - `apps/daemon/src/db/migrations.ts` (`0014+` forward migration allocation): **Single coordinated owner** (preserving `0001`–`0013` immutable)
  - `package.json` / `pnpm-lock.yaml`: **Single coordinated owner**
- **Parallel Track Boundaries**:
  - **Alpha.1 (Group Bot & Private Task Chat)**: `packages/teams/`, `apps/daemon/src/teams/`, and new Group Bot UI components.
  - **Alpha.2 (Right-hand Workspace Panel)**: New workspace service/module in `apps/daemon/src/workspace/` (reusing `realpath` + `O_NOFOLLOW` containment) and new Workspace Panel tab components (`Files/Editor`, `Changes`, `Browser`, `Output`).
