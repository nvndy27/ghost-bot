# Alpha.0A: Native Chat Closure & Integration Readiness

Date: 2026-11-27
Branch: `feat/alpha0a-native-chat-closure` (stacked on `feat/provider7-unified-execution` @ `0291693`)

## 1. Targeted Findings (A0-01 – A0-06)

| Finding | Reproduction / Root Cause at `0291693` | Resolution & Verification |
|---|---|---|
| **A0-01**: Effective model & config consistency | `resumeSession()` across `OpenAiCompatibleRuntimeBase`, `AnthropicClaudeApiAdapter`, `GoogleGeminiApiAdapter`, and `OllamaLocalAdapter` did not reject changes to `modelId`, `effort`, `permission`, or `instructions` when reusing in-memory sessions; `RunOrchestrator` did not reject stale session config or validate discovered models/efforts at dispatch; `BotEditorModal.tsx` left Effort `<select>` enabled for `efforts: []` providers. | Added config equality checks in `resumeSession()` across all 4 adapters; added `SESSION_CONFIG_MISMATCH` (409), `UNSUPPORTED_MODEL` (400), `UNSUPPORTED_EFFORT` (400), and `PERMISSION_DENIED` (403) checks in `RunOrchestrator.startRun()`; disabled Effort `<select>` in `BotEditorModal.tsx` when `supportedEfforts.length === 0`. Verified via `tests/alpha0a-native-chat-closure.test.ts`. |
| **A0-02**: Atomic execution configuration | `RunOrchestrator.startRun()` re-read `agents` inside `dbHandle.transaction()` without verifying equality with `preBot` / `preSession`; `executeCodexRun()` and `executeUnifiedProviderRun()` did not re-verify DB bot/session state immediately before adapter dispatch. | Added `EXECUTION_CONFIG_CHANGED` (409) check inside `dbHandle.transaction()` when any of `agent_id`, `runtime_id`, `model_id`, `effort`, `permission_mode`, `workspace_path`, or `instructions` changed during async preflight; added `instructions` and `accountKey` to immutable `config_snapshot_json`; added pre-dispatch DB verification in `executeUnifiedProviderRun()` and `executeCodexRun()` plus deterministic `onBeforeTransactionInStartRun` / `onBeforeDispatchInRun` barrier tests. |
| **A0-03**: Per-bot account & credential resolution | `agents` table has no per-bot `account_id`; Claude, Gemini, and OpenRouter each support a single active `accountRef = 'default'`. | Preserved frozen migrations `0001`–`0013` (no schema change required). Enforced explicit single-account `accountKey` binding (`provider:accountRef:credentialGeneration` / `runtimeId:baseUrl:configGeneration`) in `sessions.account_id` and `RuntimePolicyBroker` (`ACCOUNT_MISMATCH` 409 on rotation/switch). |
| **A0-04**: Canonical history & context isolation | `executeUnifiedProviderRun()` concatenated `buildBoundedCanonicalHistory()` output into `sessionConfig.instructions` (`system` role), elevating untrusted conversation history into privileged system instructions. | Added `ConversationHistoryTurn` and `history?: ConversationHistoryTurn[]` to `SessionConfig` (`packages/shared-types/runtime.ts`); updated `buildBoundedCanonicalHistory()` to query `LIMIT 40` bounded at SQLite, redact secrets (`redactSecrets()`), and return structured `user`/`assistant` turns; updated `OpenAiCompatibleRuntimeBase`, `AnthropicClaudeApiAdapter`, `GoogleGeminiApiAdapter`, and `OllamaLocalAdapter` to seed `state.history` directly without touching `system` instructions. Verified role separation and secret redaction in `tests/alpha0a-native-chat-closure.test.ts`. |
| **A0-05**: Production-path provider coverage | Provider.7 covered `lmstudio` and `openrouter` daemon execution and fail-closed denials. | Extended `tests/alpha0a-native-chat-closure.test.ts` with full `GhostBotDaemon` / `RunOrchestrator` -> `RuntimePolicyBroker` -> adapter execution for `llamacpp` (real loopback HTTP), `claude-api` (synthetic transport + SecretStore), `gemini-api` (synthetic transport + SecretStore), and `ollama` (real loopback HTTP `/api/tags`, `/api/show`, `/api/chat`), while keeping `openclaw` and `kimi-acp` fail-closed. |
| **A0-06**: Test isolation & production security | Needed verification that `--no-sandbox` is restricted to test launchers and `NODE_USE_ENV_PROXY=1` proxies cannot silently intercept loopback adapter traffic. | Verified `sandbox: true` in `apps/desktop/electron/main.ts` (`--no-sandbox` absent from `apps/`); `testProviderAdapters` exists only on in-process `DaemonServerOptions`; added `assertNoLoopbackProxyBypass()` in `openai-compatible-transport.ts` to block loopback calls when `NODE_USE_ENV_PROXY=1` has active proxy env vars without `NO_PROXY`. |

## 2. Per-Provider Production-Path Acceptance Matrix

| Runtime ID | Auth / Secret Boundary | Daemon -> Orchestrator -> PolicyBroker Path | Resume & Limitation | Live Status |
|---|---|---|---|---|
| `codex` | Dedicated ChatGPT profile (`~/.config/ghost-bot/codex-profile`) | `executeCodexRun()` + `CodexAppServerAdapter` | Native `thread/resume`; `full-access` disabled; `unsupported_native_mcp` | Previously live-verified on CLI `0.172.0` |
| `lmstudio` | Loopback `http://127.0.0.1:1234/v1` + explicit `executionAuthorized` | `executeUnifiedProviderRun()` + `LmStudioLocalAdapter` | Stateless HTTP; structured DB history seeded on restart; `read-only` tool-free; `efforts: []` | Verified against real loopback HTTP + Electron E2E; host binary absent |
| `llamacpp` | Loopback `http://127.0.0.1:8080/v1` + explicit `executionAuthorized` | `executeUnifiedProviderRun()` + `LlamaCppLocalAdapter` | Stateless HTTP; structured DB history seeded on restart; `read-only` tool-free; `efforts: []` | Verified against real loopback HTTP + daemon; host binary absent |
| `openrouter` | `ghost-bot.provider` keyring (`sk-or-v1-...`) + explicit opt-in | `executeUnifiedProviderRun()` + `OpenRouterApiAdapter` | Stateless HTTP; `allow_fallbacks: false`; `read-only` tool-free; single account (`default`) | Verified via synthetic transport; live API gated |
| `claude-api` | `ghost-bot.provider` keyring (`sk-ant-...`) + explicit opt-in | `executeUnifiedProviderRun()` + `AnthropicClaudeApiAdapter` | Stateless HTTP; `read-only` tool-free; single account (`default`); `efforts: []` | Verified via synthetic transport; live API gated |
| `gemini-api` | `ghost-bot.provider` keyring (`x-goog-api-key`) + explicit opt-in | `executeUnifiedProviderRun()` + `GoogleGeminiApiAdapter` | Stateless HTTP; `read-only` tool-free; single account (`default`); `efforts: []` | Verified via synthetic transport; live API gated |
| `ollama` | Loopback `http://127.0.0.1:11434` + local-only check | `executeUnifiedProviderRun()` + `OllamaLocalAdapter` | Local `/api/chat`; rejects `:cloud` models; `read-only` tool-free; `efforts: []` | Verified against real loopback HTTP + `RunOrchestrator`; host binary absent |
| `openclaw` | Loopback WS `127.0.0.1:18789` | Fail-closed `403 PERMISSION_DENIED` | Metadata verified (`operator.read`); execution gated until upstream sandbox/billing verified | Execution gated |
| `kimi-acp` | Local `kimi acp` stdio | Fail-closed `403 PERMISSION_DENIED` | ACP v1 protocol-tested; `fs/*` & `terminal/*` disabled | Execution gated; CLI absent on host |

## 3. PR #6–#13 Convergence & Documentation Reconciliation Plan

1. **Stacked Technical Chain (merge order)**:
   - PR #6 (`feat/provider1-openclaw-execution` -> `feat/core2-scoped-skills-terminal`)
   - PR #7 (`feat/provider2-ollama-local` -> `feat/provider1-openclaw-execution`)
   - PR #8 (`feat/provider3-claude-api` -> `feat/provider2-ollama-local`)
   - PR #9 (`feat/provider4-gemini-api` -> `feat/provider3-claude-api`)
   - PR #10 (`feat/provider5-kimi-acp` -> `feat/provider4-gemini-api`)
   - PR #11 (`feat/provider6-openai-compatible` -> `feat/provider5-kimi-acp`)
   - PR #13 (`feat/provider7-unified-execution` -> `feat/provider6-openai-compatible`)
   - **Alpha.0A PR** (`feat/alpha0a-native-chat-closure` -> `feat/provider7-unified-execution`)
2. **Documentation PR #12 (`docs/v0.1-personal-friends-alpha` -> `feat/provider6-openai-compatible`)**:
   - Contains owner-approved Alpha.0–Alpha.3 scope in `README.md`, `docs/ROADMAP.md`, `docs/NEXT_STEPS.md`, `docs/KNOWN_ISSUES.md`, and `docs/PROGRESS.md`.
   - **Conflict-prone shared files**: `README.md`, `docs/ROADMAP.md`, `docs/NEXT_STEPS.md`, `docs/KNOWN_ISSUES.md`, `docs/PROGRESS.md`.
   - **Reconciliation rule**: Rebase/merge PR #12 *after* PR #13 + Alpha.0A PR (or apply Alpha.0A doc reconciliation cleanly), keeping PR #12's `v0.1 Personal & Friends Alpha` product scope (`Alpha.0`–`Alpha.3`) AND Provider.7 + Alpha.0A's verified technical evidence without reverting either.
3. **Agent 2 Platform/Security Coordination**:
   - Any verified Agent 2 packaging/platform/security checkpoint lands on top of the converged Alpha.0A baseline before tagging Alpha.0 complete.

## 4. Alpha.1 / Alpha.2 Contract Inventory (Planning Only)

Based on existing canonical entities (`apps/daemon/src/db/migrations.ts`, `packages/shared-types/ipc.ts`, `packages/shared-types/runtime.ts`, `apps/daemon/src/teams/service.ts`, `apps/daemon/src/teams/execution-bridge.ts`):

- **Identifiers**:
  - Bot: `agents.id` (`BotIdSchema`), Session: `sessions.id` (`SessionIdSchema`, `agent_id`, `account_id`, `runtime_id`, `external_session_id`), Run: `runs.id` (`RunIdSchema`, `config_snapshot_json`), Team: `teams.id` (`TeamIdParamSchema`), Team Run: `team_runs.id` (`TeamRunIdParamSchema`), Task: `team_tasks.id` (existing task ledger in `0008_teams_core`), Workspace: canonical `realpath` `workspace_path`.
- **Effective Configuration**:
  - `BotRecord` (`runtimeId`, `modelId`, `effort`, `permission`, `workspacePath`, `instructions`) + team-member overrides (validated per-member against discovered adapter capabilities & `RuntimePolicyBroker` at dispatch, snapshotted immutably in `runs.config_snapshot_json`).
- **Workspace Grant Ownership**:
  - One canonical `workspace_path` per bot; Alpha.2 Workspace Panel file/edit/Git/preview IPC must derive `realpath` containment from the active bot/task's `workspacePath` and enforce daemon-side `O_NOFOLLOW` + path-prefix checks (reusing `KnowledgeService` / `ScopedTerminalService` boundary patterns).
- **Artifact & Evidence References**:
  - Existing `run_events` (`RuntimeEventV1` with monotonic `seq`), `messages` (`content_json`), `approvals` + `mcp_approval_bindings` / `terminal_commands` / `computer_use_actions`.
- **Private Task Chat Navigation (Alpha.1)**:
  - Reuse `TeamsService` and `TeamsExecutionBridge` rather than introducing a second team engine. Task delegation creates/links a dedicated `sessions` row under the assigned `agent_id` (`team_tasks` -> `session_id` / `run_id`), surfaced in the sidebar under the bot and linked from the originating Group Bot summary card.
- **Shared Ownership Boundaries**:
  - Migrations `0001`–`0013` remain frozen; any `0014+` migration, `packages/shared-types/ipc.ts` channel additions, and `apps/desktop/src/App.tsx` layout wiring must be allocated through a single coordinated owner per milestone.

## 5. Remaining Alpha.0 Acceptance Blockers

1. **Bounded live inference checks** (not authorized in this offline checkpoint): verify at least one live non-Codex provider path when explicitly authorized (e.g., local Ollama/LM Studio/llama.cpp server or bounded opt-in API key test), alongside Codex CLI `0.172.0` live smoke.
2. **PR Convergence & Agent 2 Sign-off**: merge stacked PRs #6–#13 + #12 + Alpha.0A PR and incorporate Agent 2's platform/packaging verification (AppImage/RPM smoke checks).
