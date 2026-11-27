# Progress log

## Provider.7 — Unified Multi-Provider Execution Integration

2026-11-27. Branched `feat/provider7-unified-execution` from `5d57c39` (`feat/provider6-openai-compatible`). Resolved the HTTP 501 `LIVE_INFERENCE_DISABLED` execution gap in `RunOrchestrator`, `RuntimeRegistry`, and `DaemonServer` across `openclaw`, `ollama`, `claude-api`, `gemini-api`, `kimi-acp`, `lmstudio`, `llamacpp`, and `openrouter` while preserving Codex and fail-closed `RuntimePolicyBroker` gating, and closed the targeted Provider.6 residual checks with zero live inference or paid API spend. See [Provider.7 report](extensions/provider7-unified-execution.md).

| State | Evidence |
|---|---|
| Implemented | Added persistent adapter ownership (`RuntimeRegistry.registerPersistentAdapter`, `getPersistentAdapter`, `getUnifiedExecutionAdapter`, `stop()` disconnect), `DaemonServer.registerPersistentProviderAdapters()` + `buildProviderPolicyInput()` + `configGeneration` tracking on `/lmstudio/config` & `/llamacpp/config`, and `RunOrchestrator.executeUnifiedProviderRun()` (pre-dispatch `RuntimePolicyBroker.authorize` revalidation, canonical `messages` history reconstruction on restart, streaming/cancellation, and uncertain-outcome quarantine without automatic replay). |
| Implemented | Closed Provider.6 residuals: `readBoundedResponseText()` incremental metadata byte limits (`openai-compatible-transport.ts`, `anthropic-claude-api.ts`, `google-gemini-api.ts`), exact path/query/fragment enforcement in `assertPinnedHttpsOriginUrl()`, removal of `allowNetworkDiscovery` unauthenticated bypass for cloud adapters, `configGeneration` in `CompatSessionState` (`A -> B -> A` invalidation), post-`[DONE]` frame suppression, and unexpected `finish_reason` rejection. |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider7-unified-execution.test.ts`, 3 consecutive full-workspace regression runs (**232/232** per run: `root` 139/139, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 16 Electron E2E/IPC scripts (`verify-provider7-unified-execution-desktop.mjs` + 15 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`14/14` PASS) all passed. |

## Provider.6 — Shared OpenAI-Compatible Runtime Integration

2026-11-27. Branched `feat/provider6-openai-compatible` from `d13e686` (`feat/provider5-kimi-acp`). Implemented shared OpenAI-compatible transport (`OpenAiCompatibleRuntimeBase`) and three provider runtimes (`lmstudio`, `llamacpp`, `openrouter`), `RuntimePolicyBroker` gates, daemon routes, Electron IPC, and Desktop Settings/`BotEditorModal` UI with zero live inference or paid API spend. See [Provider.6 report](extensions/provider6-openai-compatible.md).

| State | Evidence |
|---|---|
| Implemented | Added `OpenAiCompatibleRuntimeBase` (`packages/runtime-adapters/openai-compat/openai-compatible-transport.ts`), `LmStudioLocalAdapter` (`lmstudio`, `http://127.0.0.1:1234/v1`), `LlamaCppLocalAdapter` (`llamacpp`, `http://127.0.0.1:8080/v1`), and `OpenRouterApiAdapter` (`openrouter`, pinned `https://openrouter.ai/api/v1`, `provider.allow_fallbacks: false`, `ghost-bot.provider` OS Secret Service key isolation). Enforces pre-request endpoint/credential/auth checks, `redirect: 'error'` + `3xx` mapping, fragmented UTF-8 SSE parsing, idle/total timeouts, abort-raced stream reads, tool-call rejection, reasoning suppression, non-cumulative usage, and `RuntimePolicyBroker` gating. |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider6-openai-compat-production.test.ts` (3/3), 3 consecutive full-workspace regression runs (**231/231** per run: `root` 138/138, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 14 Electron E2E/IPC scripts (`verify-provider6-openai-compat-desktop.mjs` + 13 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`MCP_CONCURRENCY_STRESS_PASSED`) all passed. |

## Provider.5 — Kimi Code ACP Runtime Integration

2026-11-27. Branched `feat/provider5-kimi-acp` from `c65a621` (`feat/provider4-gemini-api`). Commit 1 (`42b708b`) closed shared provider pre-request credential revalidation, proactive abort on rotation/revocation, and stalled stream cancellation; Commit 2 implemented `KimiAcpAdapter` (`kimi-acp`), `RuntimePolicyBroker.authorizeKimiAcpExecution()`, `GET /kimi/status`, `IPC_CHANNELS.KIMI_STATUS`, and Desktop Settings & BotEditorModal UI with zero live inference or CLI installation. See [Provider.5 report](extensions/provider5-kimi-acp.md).

| State | Evidence |
|---|---|
| Verified | Shared provider security hardening (`42b708b`): immediate pre-request `credentialGeneration`/`isExecutionAuthorized()`/`resolveApiKey()` verification, `abortActiveRuns()` on rotation/deletion/revocation, and abort-raced `readWithAbort()` for stalled SSE streams (`tests/shared-provider-security.test.ts` PASS). |
| Implemented | Added `KimiAcpAdapter` (`packages/runtime-adapters/kimi/kimi-acp.ts`) speaking ACP v1 JSON-RPC over stdio (`initialize`, `session/new`, `session/load`, `session/prompt`, `session/update`, `session/request_permission`, `session/cancel`) with `fs/*` & `terminal/*` callback rejection, `allow_always` stripping, `agent_thought_chunk` suppression, session quarantine on unexpected exit, `RuntimePolicyBroker.authorizeKimiAcpExecution()`, and Desktop Settings / BotEditorModal UI. `kimi` CLI is not installed on host. |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider5-kimi-production.test.ts` (2/2), 3 consecutive full-workspace regression runs (**228/228** per run: `root` 135/135, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 13 Electron E2E/IPC scripts (`verify-provider5-kimi-desktop.mjs` + 12 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`MCP_CONCURRENCY_STRESS_PASSED`) all passed. |

## Provider.4 — Google Gemini API Production Integration

2026-11-27. Branched `feat/provider4-gemini-api` from `fcded26` (`feat/provider3-claude-api`). Implemented `GoogleGeminiApiAdapter` (`v1beta/models`, `streamGenerateContent?alt=sse`, `x-goog-api-key`), shared provider credential hardening, Desktop Settings & BotEditorModal UI, and read-only Gemini CLI assessment with zero live inference or external API requests. See [Provider.4 report](extensions/provider4-gemini-api.md).

| State | Evidence |
|---|---|
| Implemented | Added `GoogleGeminiApiAdapter` (`packages/runtime-adapters/gemini/google-gemini-api.ts`) pinned to `https://generativelanguage.googleapis.com` (`v1beta`), `x-goog-api-key` header (query `?key=` rejected), paginated `generateContent` model discovery, `read-only` tool-free SSE streaming, non-cumulative `usageMetadata` snapshot emission, safety/`MAX_TOKENS`/`thought` handling, mid-stream credential rotation abort (hardened across both Claude and Gemini adapters), stale `accountRef` cleanup in `apps/daemon/src/server.ts`, `RuntimePolicyBroker.authorizeGeminiApiExecution()`, `/gemini/*` daemon routes, `IPC_CHANNELS.GEMINI_*`, and `SettingsModal.tsx` / `BotEditorModal.tsx` UI. |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider4-gemini-production.test.ts` (2/2), 3 consecutive full-workspace regression runs (**225/225** per run: `root` 132/132, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 12 Electron E2E/IPC scripts (`verify-provider4-gemini-desktop.mjs` + 11 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`MCP_CONCURRENCY_STRESS_PASSED`) all passed. |

## Provider.3 — Anthropic Claude API Integration & Targeted Core Hardening

2026-11-27. Branched `feat/provider3-claude-api` from `94a71dc` (`feat/provider2-ollama-local`). Commit 1 (`edfbad1`) closed `CORE2-TERM-01` and `CORE1-SS-01`; Commit 2 implemented `AnthropicClaudeApiAdapter` and provider credential namespace with zero live inference or external API calls. See [Provider.3 report](extensions/provider3-claude-api.md).

| State | Evidence |
|---|---|
| Verified | Closed `CORE2-TERM-01` (`ScopedTerminalService.revokeByRunId`/`revokeByBotId` wired to `RunOrchestrator.setOnRunTerminated` and `PATCH/DELETE /bots/:id`, startup race closed, unconfirmed running commands marked `uncertain`) and `CORE1-SS-01` (`LinuxSecretServiceStore.getStatus()` fails closed when `busctl`, `org.freedesktop.secrets`, or collections are unavailable/locked) in `tests/core-security-hardening.test.ts` (2/2 PASS). |
| Implemented | Added `AnthropicClaudeApiAdapter` (`packages/runtime-adapters/claude/anthropic-claude-api.ts`) pinned to `https://api.anthropic.com` (`anthropic-version: 2023-06-01`), `read-only` tool-free SSE streaming, bounded history/tokens/duration/stream, `maxAttempts: 1`, `ProviderSecretCoordinate` (`ghost-bot.provider`) in `SecretStore`, `RuntimePolicyBroker.authorizeClaudeApiExecution()`, `/claude/*` daemon routes, `IPC_CHANNELS.CLAUDE_*`, and `SettingsModal.tsx` / `BotEditorModal.tsx` UI. Assessed local `claude` CLI `2.1.331` read-only (`capabilities.claudeCodeCli: false`). |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider3-claude-production.test.ts` + `tests/core-security-hardening.test.ts` (4/4), 3 consecutive full-workspace regression runs (**223/223** per run: `root` 130/130, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 11 Electron E2E/IPC scripts (`verify-provider3-claude-desktop.mjs` + 10 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`MCP_CONCURRENCY_STRESS_PASSED`) all passed. |

## Provider.2 — Ollama Local Runtime Production Integration

2026-11-27. Branched `feat/provider2-ollama-local` from `d6436c6` (`feat/provider1-openclaw-execution`). Offline Provider.2 implementation is **Tested / Implemented** (host Ollama CLI/daemon unavailable) with zero live inference, model downloads, or `sudo` changes. See [Provider.2 report](extensions/provider2-ollama-local.md).

| State | Evidence |
|---|---|
| Implemented | Hardened `OllamaLocalAdapter` (`packages/runtime-adapters/ollama/ollama-adapter.ts`): loopback-only URLs without credentials, `redirect: 'error'` + explicit `3xx` rejection, cloud-model rejection (`:cloud`, `remote_model`, `remote_host`), `listModelDetails`, `inspectModel`, `listRunningModels`, `inspectLocalRuntime`, `resumeSession`, `inspectSession`, `reconnect`, `read-only` tool-free enforcement, `maxConcurrentRuns`, `24`-turn/`32 KB` history, `num_predict` cap, `120s` timeout, `2 MB` stream limit, `OLLAMA_UNKNOWN_TERMINATION` on incomplete streams, and actual token usage mapping (`getUsage() -> null`). |
| Implemented | Added `RuntimePolicyBroker.authorizeOllamaExecution()` (`apps/daemon/src/runtime/policy-broker.ts`), `RuntimeRegistry.getOllamaStatus()` (`apps/daemon/src/runtime/registry.ts`), `GET /ollama/status` (`apps/daemon/src/server.ts`), `IPC_CHANNELS.OLLAMA_STATUS` + `OllamaStatusDtoSchema` (`packages/shared-types/ipc.ts`), Electron preload/main handlers, and `SettingsModal.tsx` / `BotEditorModal.tsx` UI integration. |
| Tested | `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build` (11/11), `tests/provider2-ollama-production.test.ts` + `tests/ollama-adapter.test.ts` (4/4), 3 consecutive full-workspace regression runs (**219/219** per run: `root` 126/126, `teams` 20/20, `scheduler` 17/17, `computer-use` 16/16, `memory` 14/14, `knowledge` 12/12, `mcp` 14/14), all 10 Electron E2E/IPC scripts (`verify-provider2-ollama-desktop.mjs` + 9 existing), and 4-worker `@ghost-bot/mcp` concurrency stress (`MCP_CONCURRENCY_STRESS_PASSED`) all passed. |

## Phase 3D.4 — Integrated End-to-End Acceptance

2026-11-26. Branched `feat/phase-3d4-integrated-acceptance` from `04e324c` (Phase 3D.3 hardened). Offline integrated RC is **Verified** (**PASS**) with zero live subscription inference turns consumed. See [Phase 3D.4 report](extensions/phase-3d4-integrated-acceptance.md).

| State | Evidence |
|---|---|
| Verified | Verified fresh + populated v4/v5/v6->v7 upgrades (`0700`/`0600` permissions, FTS5 consistency, foreign keys), atomic bot archival rollback across Core + Memory + Knowledge + MCP, combined `4096`/`8192`/`12288`-byte UTF-8 budgets, and `CodexAppServerAdapter` dispatch-time revalidation (`tests/phase-3d4-integrated.test.ts`). |
| Verified | Verified unified 27-step Memory + Knowledge + MCP + restart Electron E2E (`scripts/verify-phase-3d4-electron.mjs`, 4 screenshots in `design/reviews/phase-3d4/`, deny = `0` invocations, approve = `1` invocation, no auto-launch on restart) and ~2500-chunk cross-extension responsiveness (`searchP50Ms: 75.27–91.63`, `searchP95Ms: 104.70–120.58`, `healthP95Ms: 1.39–1.53`, `eventLoopP95Ms: 10.74–10.76`). |
| Verified | Rebuilt and verified Linux AppImage (`GhostBot-0.1.0-x86_64.AppImage`, sha256 `b8d45e8b0eb4d232a20bef2cff47fd3dc88dc34bc8368b5df73083f3893faca8`, `APPIMAGE_EXTRACT_AND_RUN=1` 2-launch E2E) and Fedora RPM (`ghost-bot-0.1.0-1.x86_64.rpm`, sha256 `24ba149303222cb8318905b4b16260969b5d6532e21018a4f6923e332103f9c6`, `rpm -qip` + extracted smoke launch, zero credentials/DB bundled). |
| Tested | `corepack pnpm install --frozen-lockfile`, `corepack pnpm -r --if-present lint`, `corepack pnpm -r --if-present typecheck` (8/8), `corepack pnpm -r --if-present build`, `corepack pnpm audit --prod` (`No known vulnerabilities found`), all 5 Electron E2E suites (`2e`, `3d1`, `3d2`, `3d3`, `3d4`), and **3 consecutive full test runs** (`14/14` memory, `12/12` knowledge, `14/14` mcp, `81/81` core = **121/121** each) all passed. |

## Phase 3D.3 — Production MCP Integration

2026-11-26. Branched `feat/phase-3d3-mcp-integration` from `9b6ba1b` (Phase 3D.2 hardened). Phase 3D.3 is **Verified** (**PASS**) with zero live subscription inference turns and native Codex MCP execution kept disabled (`unsupported_native_mcp`). See [Phase 3D.3 report](extensions/phase-3d3-mcp-integration.md).

| State | Evidence |
|---|---|
| Verified | Added `createBorrowedMcpDatabaseHandle()` (`packages/mcp/src/storage/sqlite-client.ts`), production migration `0007_mcp_core` (`mcp_servers` + `mcp_approval_bindings` in `apps/daemon/src/db/migrations.ts`, `schema.ts`), and `RuntimePolicyBroker.createMcpPolicyAdapter()` (`apps/daemon/src/runtime/policy-broker.ts`) blocking `full-access` and `read-only` for local STDIO MCP. |
| Verified | Implemented daemon-owned `McpService` (`apps/daemon/src/mcp/service.ts`) with trusted `McpAuthContext`, explicit trust + binary digest pinning, fail-closed default `McpSecretResolver`, `archiveMcpForBotInTx()` + post-commit `invalidateBotConnections()` on `DELETE /bots/:id`, and `RunOrchestrator` durable `approvals` + `mcp_approval_bindings` single-use execution (`pending -> dispatched -> completed | failed | uncertain | cancelled`). |
| Verified | Wired 12 Zod v4 MCP IPC channels (`packages/shared-types/ipc.ts`, `apps/desktop/electron/preload.cts`, `main.ts`), `McpSettingsSection` UI (`apps/desktop/src/components/McpSettingsSection.tsx`, `SettingsModal.tsx`), and `/mcp/*` daemon routes (`apps/daemon/src/server.ts`). |
| Tested | `corepack pnpm install --frozen-lockfile`, `corepack pnpm -r --if-present lint`, `corepack pnpm -r --if-present typecheck` (8/8), `corepack pnpm -r --if-present build`, `corepack pnpm audit --prod` (`No known vulnerabilities found`), `verify-phase-2e-acceptance.mjs`, `verify-phase-3d1-electron.mjs`, `verify-phase-3d2-electron.mjs`, `verify-phase-3d3-electron.mjs` (4 screenshots in `design/reviews/phase-3d3/`), cross-extension responsiveness benchmark (`searchP95Ms: 17.43–21.92`, `healthMemoryP95Ms: 3.78–5.66`, `eventLoopP95Ms: 10.43–10.76`), hardening regressions (`tests/phase-3d3-hardening.test.ts`), and **3 consecutive full test runs** (`14/14` memory, `12/12` knowledge, `14/14` mcp, `78/78` core = **118/118** each) all passed. |

## Phase 3D.2 — Production Knowledge & Retrieval Integration

2026-11-26. Branched `feat/phase-3d2-knowledge-integration` from `ac4f80d` (Phase 3D.1 closure gate). Phase 3D.2 is **Verified** (**PASS**) with zero MCP production integration and zero live subscription inference turns. See [Phase 3D.2 report](extensions/phase-3d2-knowledge-integration.md).

| State | Evidence |
|---|---|
| Verified | Added production migration `0006_knowledge_core` (`apps/daemon/src/db/migrations.ts`, `schema.ts`) and `createBorrowedKnowledgeDatabaseHandle()` (`packages/knowledge/src/storage/sqlite-client.ts`) so `KnowledgeService.close()` never closes the daemon's `DatabaseSync`. |
| Verified | Implemented daemon-owned `KnowledgeService` (`apps/daemon/src/knowledge/service.ts`) constructing trusted `KnowledgeAuthContext`, supporting `direct_text`, UTF-8 `.txt`, and `.md`/`.markdown` (via Electron `dialog.showOpenDialog` in `apps/desktop/electron/main.ts` + `O_NOFOLLOW`), revision-aware citations (`resolveCitation`), and atomic bot-scoped archival via `archiveKnowledgeForBotInTx()` in `DELETE /bots/:id`. |
| Verified | Added `KnowledgeSettingsSchema` / `KnowledgeSettingsPatchSchema` (`enabled: true`, `automaticRetrieval: false`, `includeUserWide: false`, `externalProviderConsent: false`), 11 strict Zod v4 IPC channels, `KnowledgeSettingsSection` UI (`apps/desktop/src/components/KnowledgeSettingsSection.tsx`), and combined Memory+Knowledge `context-assembler.ts` (`<= 12288` bytes) with `CodexAppServerAdapter.run()` `prepareReferenceContext` revalidation. |
| Tested | `corepack pnpm install --frozen-lockfile`, `corepack pnpm lint`, `corepack pnpm -r --if-present typecheck` (8/8), `corepack pnpm -r --if-present build`, `corepack pnpm audit --prod` (0 vulns), `verify-phase-2e-acceptance.mjs`, `verify-phase-3d1-electron.mjs`, `verify-phase-3d2-electron.mjs` (2 screenshots in `design/reviews/phase-3d2/`), 573-chunk (`searchMs: 44.04`, `prepareMs: 36.95`) and 2501-chunk (`searchMs: 255.35`) benchmarks, hardening regressions (bytes-only ingestion, cross-scope collection rejection, atomic rollback, `run.context_prepared`), and **3 consecutive full test runs** (`14/14` memory, `12/12` knowledge, `14/14` mcp, `71/71` core = **111/111** each) all passed. |

## Phase 3D.1 — Production Memory Integration

2026-11-26. Branched `feat/phase-3d1-memory-integration` from `158a728`. Phase 3D.1 is **Verified** (**PASS**) with zero Knowledge/MCP production integration and zero live subscription inference turns. See [Phase 3D.1 report](extensions/phase-3d1-memory-integration.md).

| State | Evidence |
|---|---|
| Verified | Added production migration `0005_memory_core` (`apps/daemon/src/db/migrations.ts`, `schema.ts`) creating `memories` (`bot_id REFERENCES agents(id) ON DELETE RESTRICT`) and `memories_fts` (`unicode61 remove_diacritics 2`); added `createBorrowedMemoryDatabaseHandle()` (`packages/memory/src/storage/sqlite-client.ts`) so `MemoryService.close()` never closes the daemon's `DatabaseSync`. |
| Verified | Implemented daemon-owned `MemoryService` (`apps/daemon/src/memory/service.ts`) constructing trusted `MemoryAuthContext` (`LOCAL_USER_ID`, `agents` ownership, `realpath` workspace hash `deriveWorkspaceId`), archiving bot-scoped memories on `DELETE /bots/:id` while preserving user-wide memories, and enforcing `MemorySettingsSchema` (`enabled: true`, `automaticRetrieval: false`, `includeUserWide: false`, `externalProviderConsent: false`). |
| Verified | Wired 6 strict Zod v4 IPC channels (`ghost:memory:*` in `packages/shared-types/ipc.ts`, `apps/desktop/electron/preload.cts`, `main.ts`, `apps/daemon/src/server.ts`), `MemorySettingsSection` (`apps/desktop/src/components/MemorySettingsSection.tsx`, `SettingsModal.tsx`), and dispatch-boundary `RunOrchestrator` + `CodexAppServerAdapter` `turn/start.input` reference context (`baseInstructions` untouched, `run_events` metadata-only). |
| Tested | `corepack pnpm install --frozen-lockfile`, `corepack pnpm lint`, `corepack pnpm -r --if-present typecheck` (8/8), `corepack pnpm -r --if-present build`, `corepack pnpm audit --prod` (0 vulns), `node scripts/verify-phase-2e-acceptance.mjs`, `node scripts/verify-phase-3d1-electron.mjs` (2 screenshots in `design/reviews/phase-3d1/`), 250-record synthetic benchmark (`searchMs: 13.61`, `prepareMs: 7.14`), closure-gate barrier tests (`CodexAppServerAdapter.run` `prepareReferenceContext`), and **3 consecutive full test runs** (`14/14` memory, `12/12` knowledge, `14/14` mcp, `67/67` core = **107/107** each) all passed. |

## Phase 3D.0 — Core and Extension Integration Foundation

2026-11-26. Branched `feat/phase-3d0-integration-foundation` from `main` (`07839ff`), merged accepted Track B (`d7ec6ba`, `feat/phase-3c-mcp-foundation`), and upgraded `zod` to `4.6.7` across all 6 dependent workspace packages. Phase 3D.0 is **Verified** (**PASS**) with zero `0005+` migrations or Phase 3D.1–3D.4 daemon wiring. See [Phase 3D.0 report](extensions/phase-3d0-integration-report.md).

| State | Evidence |
|---|---|
| Verified | Merged `d7ec6ba` (`--no-ff`) onto `07839ff` preserving Track A (`electron-builder@26.0.12`, `apps/desktop/scripts/build-rpm.mjs`, migrations `0001`–`0004`) and Track B (`@ghost-bot/memory`, `@ghost-bot/knowledge`, `@ghost-bot/mcp` remaining daemon-agnostic). |
| Verified | Upgraded `"zod": "^4.6.7"` across all 6 workspace packages (`shared-types`, `memory`, `knowledge`, `mcp`, `desktop`, `daemon`), resolving `GHSA-mrhx-c7xc-m3w5` (`corepack pnpm audit --prod`: `No known vulnerabilities found`; `corepack pnpm list -r zod --depth 0`: all `zod@4.6.7`). Fixed Zod v4 strictness in `packages/shared-types/ipc.ts` (`.prefault({})` on `AppSettingsSchema` sections) and `packages/mcp/src/contracts/schemas.ts` (`z.record(z.string(), z.unknown())`). |
| Tested | `corepack pnpm install --frozen-lockfile`, `corepack pnpm -r --if-present typecheck` (8/8), `corepack pnpm lint`, `corepack pnpm -r --if-present build`, `node scripts/verify-phase-2e-acceptance.mjs` (`0` console errors, `daemonExitedCleanly: true`), and **3 consecutive full test runs** (`14/14` memory, `12/12` knowledge, `14/14` mcp, `62/62` core = **102/102** each) all passed. |

## Phase 2D — Runtime Recovery, Reconnect, Resume & Release Preparation

2026-11-26. Phase 2C merged to `main` (`c7891af`); Phase 2D **Implemented & Offline-Tested** on `feat/phase-2d-recovery-resume` (**CONDITIONAL PASS**: `55/55` unit tests and Electron recovery E2E passed; `electron-builder` not installed for AppImage/RPM artifact build and `GHOST_BOT_RUN_LIVE_RECOVERY=1` not executed without new live budget).

| State | Evidence |
|---|---|
| Implemented | Extended `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`) with explicit `RuntimeLifecycleState` (`unavailable`, `connecting`, `connected`, `disconnected`, `reconnecting`, `authentication_required`, `unsupported`, `failed`), deduplicated `reconnect()`, and `closeOwnedClient()`. |
| Implemented | Hardened `RunOrchestrator` quarantine (`sessionsWithUnconfirmedStop`) so generation changes alone cannot clear quarantine without confirmed provider termination or `reconnectRuntime()` closing the owned runtime; added `inspectSession()` and explicit manual `retryRun()` (`SESSIONS_INSPECT`, `RUNS_RETRY`, `RUNTIME_RECONNECT`). |
| Implemented | Extended `RightPanel.tsx` and `App.tsx` with recovery banners (`interrupted`, `failed`, `quarantined`), explicit `Retry prompt` / `Reconnect runtime` / `New chat` actions, and usage refresh + reset timestamp display without auto-replay. |
| Implemented | Added Fedora/Linux packaging configuration (`apps/desktop/electron-builder.yml`, `apps/desktop/build/icon.svg`); `rpmbuild` is present on host, `electron-builder` is absent (no AppImage/RPM artifact built yet). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (**55/55** including `tests/phase-2d-recovery.test.ts`), Electron smoke, `verify-phase-1b-ui.mjs` through `verify-phase-2c-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, `verify-phase-2a-electron.mjs`, and `verify-phase-2d-electron.mjs` (2 screenshots in `design/reviews/phase-2d/`) all passed. |

## Phase 2E — Multi-Runtime Completion, Packaging & Functional MVP Acceptance

2026-11-26. Branched `feat/phase-2e-functional-mvp` from `main` (`4489f2b`). Phase 2E is **Verified** (**PASS**) and merged to `main`. All **62/62** unit/protocol tests across 3 consecutive runs, `pnpm verify:offline`, OpenClaw/Ollama security hardening, AppImage 2-launch verification, native `rpmbuild` Fedora RPM generation + extracted-package smoke launch, and total process-tree resource measurements passed with zero additional live inference turns.

| State | Evidence |
|---|---|
| Verified | Hardened `reconcileOnStartup()` (`apps/daemon/src/execution/orchestrator.ts`) to reconstruct durable quarantine for all live non-terminal states (`starting`, `running`, `awaiting_approval`, `cancelling`) while leaving `queued` and `mock` runs unquarantined; hardened `JsonRpcClient.close()` (`packages/runtime-adapters/json-rpc-client.ts`) to confirm child exit before resolving. |
| Verified | Hardened `OpenClawGatewayAdapter` (`maxBuffer: 1MB`, credential redaction on error strings, strict loopback validation, execution gated by `RuntimePolicyBroker`) and `OllamaLocalAdapter` (`OLLAMA_MAX_HISTORY_BYTES = 32KB`, `OLLAMA_MAX_STREAM_BYTES = 2MB`, loopback-only, `read-only` tool-free); verified live OpenClaw `2026.11.8` metadata (`health`, `status`, `models.list`) and deterministic protocol suites (`tests/openclaw-adapter.test.ts`, `tests/ollama-adapter.test.ts`, `tests/phase-2e-mvp.test.ts`). |
| Verified | Built native Fedora RPM (`apps/desktop/scripts/build-rpm.mjs`, `ghost-bot-0.1.0-1.x86_64.rpm`, `93996141` bytes, SHA-256 `74cd2950b57e1c6b4b7926f45c7bb78a06c785b4c8d0b5b8bac2088529710cdc`) via `/usr/bin/rpmbuild` v6.1.0 without `fpm`/`libcrypt.so.1`; inspected metadata/deps/scripts and passed `rpm2cpio | cpio` extracted-package smoke launch (`sandboxed: true`). |
| Verified | Rebuilt `apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage` (`121058094` bytes, SHA-256 `8bc27be83628f00fd5d697283dc3dfa55f1ffeb2f49ec5152348313daede61af`) and passed `scripts/verify-packaged-appimage.mjs` (`APPIMAGE_EXTRACT_AND_RUN=1`, 0 bundled credentials/DBs, `sandboxed: true`, strict CSP, 2-launch SQLite persistence `0700`/`0600`). |
| Verified | Measured application-only process-tree resources & 15-step UX (`scripts/verify-phase-2e-acceptance.mjs`): cold `1695ms`, warm `1774ms`, daemon `186.2 MB` RSS / `130.1 MB` PSS, total tree `685.4 MB` RSS / `380.4 MB` PSS, renderer `118.8 MB`, GPU `139.5 MB`, idle CPU `0.66%`, streaming `189ms`, refresh `4ms`, history `6ms`, shutdown `1869ms`, `daemonExitedCleanly: true`. |
| Tested | `pnpm lint`, `pnpm typecheck`, **3x `pnpm test` (`62/62` each)**, `pnpm verify:offline`, `pnpm package:appimage`, `pnpm package:rpm`, Electron smoke, 5 UI suites (`1B`–`2C`), 4 Electron E2E suites (`persistence`, `1D`, `2A`, `2D`), and `verify-packaged-appimage.mjs` all passed after final edits. |
| Blocked | Host FUSE2 (`libfuse.so.2`) absent for native AppImage FUSE launch (`APPIMAGE_EXTRACT_AND_RUN=1` verified); host-installed RPM launch not run without authorization; live OpenClaw/Ollama inference not authorized. |

### Phase 2D final acceptance & merge — 2026-11-26

Phase 2D is **Verified** (**PASS** with authorized RPM packaging deferral to Phase 2E) on `feat/phase-2d-recovery-resume` and merged to `main`.

| State | Evidence |
|---|---|
| Verified | Hardened `RuntimeRegistry.closeOwnedClient()` (`apps/daemon/src/runtime/registry.ts`) and `POST /runtime/reconnect` (`apps/daemon/src/server.ts`) so runtime termination failures throw `RUNTIME_TERMINATION_FAILED` and preserve durable `sessionsWithUnconfirmedStop` quarantine (`execution.quarantinedSessions.v1`) across restarts. |
| Verified | Hardened `RunOrchestrator.retryRun()` (`apps/daemon/src/execution/orchestrator.ts`, `packages/shared-types/ipc.ts`, `apps/desktop/electron/main.ts`, `apps/desktop/src/App.tsx`) to require `confirmSideEffects: true` (`RETRY_CONFIRMATION_REQUIRED`) and explicit two-step UI confirmation when `hasToolActivityForRun()` is true. |
| Verified | Added `CodexAppServerAdapter.readThread()` (`thread/read`, `includeTurns: false`) and updated `RunOrchestrator.inspectSession()` to validate `accountKey` ownership and live provider thread accessibility (`providerThreadStatus`: `accessible` / `unavailable` / `unknown`); added focused regression tests in `tests/phase-2d-recovery.test.ts` (**56/56** total tests). |
| Verified | Authorized 2-turn live recovery (`GHOST_BOT_RUN_LIVE_RECOVERY=1 node scripts/verify-phase-2d-live.mjs`, **2/2 turns** consumed, `sessionId: "sess_3aa2c48c-9a91-4c92-825a-9bec3f1e2c51"`, `threadId: "01a213e8-cfce-7ab3-87f8-831c5c768078"`): Turn 1 (`GHOST_2D_TOKEN_91`), Electron restart (0 auto-inference), `reconnectRuntime()` (`lifecycleState: "connected"`), `inspectSession()` (`providerThreadStatus: "accessible"`, `resumable: true`, `quarantined: false`), Turn 2 same-thread recall (`GHOST_2D_TOKEN_91`), `run_events >= 4`, `workspaceIntact: true`; screenshots in `design/reviews/phase-2d/`. |
| Verified | Packaged `apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage` (`121054137` bytes, SHA-256 `7b02c1d49ef2af99548dd5fdaf485ebe49efa642e116950a48b4136edc0bf610`) passed `scripts/verify-packaged-appimage.mjs` (0 bundled credentials/user data, `sandboxed: true`, strict CSP `default-src 'self'`, daemon startup, mock execution, 2-launch SQLite persistence `0700`/`0600`, clean shutdown; `APPIMAGE_EXTRACT_AND_RUN=1` required on Fedora 45 without `libfuse.so.2`). |
| Tested | `pnpm lint`, `pnpm typecheck`, 2x `pnpm test` (**56/56**), `pnpm build`, Electron smoke (`GHOST_BOT_SMOKE_EXIT=1`), 5 Playwright UI suites (`1B`, `1C`, `1D`, `2A`, `2C`), 4 Electron E2E suites (`verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, `verify-phase-2a-electron.mjs`, `verify-phase-2d-electron.mjs`), and `verify-packaged-appimage.mjs` all passed after final code edits. |
| Blocked | `pnpm package:rpm` remains blocked by missing host `libcrypt.so.1` (`libxcrypt-compat`) for `electron-builder`'s bundled `fpm` (deferred to Phase 2E per human authorization). `full-access` and persistent `Approve Always` remain gated/disabled. |

## Phase 2C — Live Tools, Interactive Approvals & Workspace Permissions

2026-11-25. Phase 2B merged to `main` (`a144aaf`); Phase 2C **Verified** (`PASS` — all offline security/approval tests and authorized 3-turn live Codex approval/workspace verification passed).

| State | Evidence |
|---|---|
| Verified | Added SQLite migration `0004_durable_approvals` (`apps/daemon/src/db/schema.ts`, `migrations.ts`) creating the durable `approvals` table binding approval ID, run/session/agent IDs, runtime generation, account identity, thread/turn/provider request IDs (`turn_id` populated from `CodexAppServerAdapter`), action type, summary, redacted args, `args_hash`, `permission_mode`, lifecycle status (`pending`, `resolving`, `approved`, `denied`, `expired`, `revoked`, `resolution_failed`), expiry, and decision metadata. |
| Verified | Hardened `CodexAppServerAdapter.handleServerRequest()` to decline privilege/network escalation requests (`withEscalatedPermissions`, `escalated`, `networkAccess`, `additionalPermissions`, `grantRoot`) and duplicate/mismatched-turn approval IDs, and hardened `RunOrchestrator` `sessionsWithUnconfirmedStop` quarantine to remain active until provider termination or runtime generation reset. |
| Verified | Unlocked `ask-approval` (`workspace-write` + `untrusted`) and `workspace` (`workspace-write` + `on-request`, `networkAccess: false`, `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true`) in `RuntimePolicyBroker.authorizeLiveExecution()`, while keeping `full-access` and `Approve Always` disabled. |
| Verified | Authorized live verification (`GHOST_BOT_RUN_LIVE_TOOLS=1 node scripts/verify-phase-2c-live.mjs`, 3 total turns consumed across session) passed: Scenario 1 `VERIFIED_DENIED` (`notes.md` unchanged), Scenario 2 `VERIFIED_APPROVED_ONCE` (`notes.md` updated to `# Initial Notes\nAPPROVED_ONCE_OK\n`), `unrelated.txt` and outside `canary.txt` untouched (`canaryIntact: true`), `approvalCount: 2` persisted in SQLite, Electron restart restoration verified, and screenshots saved in `design/reviews/phase-2c/`. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (`53/53`), Electron smoke, `verify-phase-1b-ui.mjs`, `verify-phase-1c-ui.mjs`, `verify-phase-1d-ui.mjs`, `verify-phase-2a-ui.mjs`, `verify-phase-2c-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, and `verify-phase-2a-electron.mjs` all passed. |

## Phase 2B — Live Codex Execution & Streaming

2026-11-25. Phase 2A hardened (`6d132e1`) and merged to `main` (`2ffc521`); Phase 2B **Verified** (`PASS` — all offline checks and authorized 3-turn live Codex Electron E2E passed).

| State | Evidence |
|---|---|
| Verified | Connected `CodexAppServerAdapter` into daemon-owned `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) via `RuntimeRegistry.getExecutionAdapter()` (with execution-time live `getAccountSummary(false)` check bypassing 30s cache) and `RuntimePolicyBroker.authorizeLiveExecution()` (`apps/daemon/src/runtime/policy-broker.ts`), restricting Phase 2B live execution to verified `0.172.0`, ChatGPT subscription auth, canonical workspace, and `read-only` permission mode. |
| Verified | Added Codex thread identity binding & continuation (`sessions.external_session_id` + `account_id` verified before `thread/start` and `thread/resume`), effective prompt composition (`bot.instructions` + `settings.personalization.defaultInstructions`/`responseStyle` on `thread/start` only), runtime generation checks, end-to-end cancellation (`turn/interrupt` + 8s `CANCEL_ACK_TIMEOUT` unconfirmed-stop session guard), and Phase 2B live approval auto-denial (`approval.denied`). |
| Verified | Updated `ChatComposer.tsx` and `App.tsx` to support verified read-only Codex prompts, live model/effort selection, disabled Phase 2C permission options, and `approval.denied` rendering while preserving mock mode separation. |
| Verified | Authorized live verification (`GHOST_BOT_RUN_LIVE_CODEX=1 node scripts/verify-phase-2b-live.mjs`, 3 turns consumed) passed: Turn 1 live `GHOST_OK` streaming, Turn 2 same-thread continuation (`external_session_id` persisted), Turn 3 live cancellation (`VERIFIED_CANCELLED`), zero unauthorized workspace changes (`sentinel.txt` intact), refreshed account usage (`usageStatus: "available"`, 2 windows), Electron restart conversation restoration, and 4 screenshots saved in `design/reviews/phase-2b/`. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (`50/50`), Electron smoke, `verify-phase-1b-ui.mjs`, `verify-phase-1c-ui.mjs`, `verify-phase-1d-ui.mjs`, `verify-phase-2a-ui.mjs`, `verify-electron-persistence.mjs`, `verify-phase-1d-electron.mjs`, and `verify-phase-2a-electron.mjs` all passed. |

## Phase 2A — Session, Run, Event and Message Persistence Foundation

2026-11-25. Phase 1D hardened (`chmod 0700` on existing Codex profile dir) and merged to `main` (`20c236a`); Phase 2A **Verified** on `feat/phase-2a-execution-foundation` after independent review and hardening (live AI inference intentionally disabled until Phase 2B).

| State | Evidence |
|---|---|
| Verified | Documented [ADR 0006](adr/0006-daemon-execution-foundation.md) and added SQLite migration `0003_execution_foundation` (`apps/daemon/src/db/schema.ts`, `migrations.ts`) adding `sessions.updated_at`/`archived_at`, `messages.seq_order`/`status`/`updated_at` (`ON DELETE RESTRICT`), `runs` (`UNIQUE(session_id, idempotency_key)`), and `run_events` (`UNIQUE(run_id, seq)`, `UNIQUE(run_id, event_key)`). |
| Verified | Built `RunStateMachine` (`apps/daemon/src/execution/state-machine.ts`), `RunEventStore` (`apps/daemon/src/execution/event-store.ts`), `SessionRepository` (`apps/daemon/src/sessions/repository.ts`), `mock-scenarios.ts`, and `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) with startup crash reconciliation (`reconcileOnStartup`), single-active-run-per-session lock, idempotency conflict detection (`IDEMPOTENCY_CONFLICT` on payload mismatch), active-run bot archival guard (`ACTIVE_RUN_EXISTS`), single-daemon `daemon.lock` ownership, bounded message batching, and explicit blocking of live Codex inference in Phase 2A (`LIVE_INFERENCE_DISABLED`). |
| Verified | Fixed genuine `CodexAppServerAdapter` `turnId` notification buffering race (`packages/runtime-adapters/codex/codex-app-server.ts` — buffering `pendingNotifications` while `active.turnId === null` when `turn/start` response and notifications coalesce in one stdout read) and added coalesced-chunk regression test (`tests/codex-adapter.test.ts`). |
| Verified | Wired 11 Zod-validated IPC channels & daemon routes (`packages/shared-types/ipc.ts`, `apps/daemon/src/server.ts`, `apps/desktop/electron/main.ts`, `preload.cts`) and integrated `App.tsx` / `ChatHeader.tsx` with daemon-owned sessions, persisted message history, `+ New chat` / session switching, `runs.start`/`cancel`/`resolveApproval`, and self-scheduling `120ms` `afterSeq` cursor polling with pagination drain. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm build`, **5 consecutive full parallel `pnpm test` runs (48/48 passing each run, 0 failures)**, Electron smoke test, `scripts/verify-phase-1b-ui.mjs` (6 screenshots), `scripts/verify-phase-1c-ui.mjs` (4 screenshots), `scripts/verify-phase-1d-ui.mjs` (5 screenshots), `scripts/verify-phase-2a-ui.mjs` (4 screenshots in `design/reviews/phase-2a/`), `scripts/verify-electron-persistence.mjs` (4 launches), `scripts/verify-phase-1d-electron.mjs` (Codex `0.172.0` metadata), and `scripts/verify-phase-2a-electron.mjs` (idempotency retry+conflict, cancel, approval, interrupted-run recovery, Codex inference blocked) all passed. |

## Phase 1D — Settings & Runtime Bridge

2026-11-25. Phase 1C upgraded (`0002_sessions_restrict_agent_delete`), hardened (`lstat` DB dir/file checks), and merged to `main` (`d371b6d`); Phase 1D **Verified**.

| State | Evidence |
|---|---|
| Verified | Implemented SQLite-backed `SettingsRepository` (`apps/daemon/src/settings/repository.ts`) with Zod validation, atomic transactions, corrupt JSON recovery, reset-to-defaults, and idempotent one-time `localStorage` appearance migration. |
| Verified | Implemented all 13 Settings sections in `SettingsModal.tsx` (`General`, `Appearance`, `Accounts & Providers`, `Models`, `Usage`, `Personalization`, `Memory`, `Tools & MCP`, `Permissions`, `Computer Use`, `Routines`, `Data & Privacy`, `Advanced`), clearly classifying persisted, runtime-managed, read-only, and deferred Phase 3/5 sections. |
| Verified | Implemented daemon-owned `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`) and `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) with request deduplication, 30s TTL cache, 2s refresh cooldown, stale fallback, secret redaction, and zero model inference. |
| Verified | Real Electron → IPC → Daemon → Policy Broker → Codex App Server `0.172.0` metadata bridge (`scripts/verify-phase-1d-electron.mjs`) confirmed `status: "available"`, `authMethod: "chatgpt"`, `planType: "plus"`, 10 discovered models, 2 live rate-limit windows, and `verifiedPermissionModes: ["read-only", "ask-approval", "workspace"]` without modifying `~/.codex` or running inference. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (40/40 tests including exact-version `0.172.0` policy broker, generation/account-switch cache invalidation, mandatory structured secret redaction, SQLite `b33f975` → `0002` upgrade, symlink DB/dir checks, adversarial SVG), `pnpm build`, Electron smoke test, 4-launch Bot persistence E2E (`verify-electron-persistence.mjs`), Phase 1D Electron mock+Codex test (`verify-phase-1d-electron.mjs`), and Phase 1B/1C/1D Playwright UI suites all passed. |

## Phase 1C — Bot management, SQLite persistence, and Avatar Editor

2026-11-25. Phase 1B merged to `main` (`24ba08b`); Phase 1C **Verified**.

| State | Evidence |
|---|---|
| Verified | Implemented SQLite persistence in `@ghost-bot/daemon` using `node:sqlite` (`DatabaseSync`, compatible across Electron 36 Node v22.19.0 and system Node v24.22.3) + `drizzle-orm/sqlite-core` + `drizzle-orm/sqlite-proxy` ([ADR 0005](adr/0005-node-sqlite-and-drizzle.md)). Persistent data dir (`0700`) and DB file (`0600`) kept separate from temporary runtime dir; `PRAGMA foreign_keys = ON`, `WAL`, transactional versioned migrations (`schema_migrations`), and single-time first-launch seeding (`seed.initial_bots.v1`). |
| Verified | Implemented Bot CRUD (`list`, `create`, `update`, `duplicate`, `delete`, `setActiveBot`), audit logging, and workspace directory picker (`dialog.showOpenDialog`) behind Zod-validated IPC (`packages/shared-types/ipc.ts`) and Bearer-authenticated daemon routes (`apps/daemon/src/bots/repository.ts`, `server.ts`). `full-access` remains rejected at Zod/daemon boundaries. |
| Verified | Implemented full Ghost Avatar Editor (`BotEditorModal.tsx`) with 12 presets, 12-color palette, 4 eye styles, rotation, animation toggle, randomize, reset, 7-state live preview, and strict custom SVG sanitization (`packages/avatar/svg-sanitizer.ts` using `isomorphic-dompurify` + tag/attribute/URL/DTD/size/complexity allowlist, rendered via inert `<img src="data:image/svg+xml;base64,...">`). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (32/32 tests including SQLite migrations, unsupported schema version rejection, soft-archive FK preservation, workspace traversal/missing-dir rejection, rollback, corrupt recovery, adversarial SVG rejection), `pnpm build`, Electron smoke test, 4-launch real Electron SQLite persistence E2E (`scripts/verify-electron-persistence.mjs`, including deleting all seeded bots across restart), and Phase 1C UI suite (`scripts/verify-phase-1c-ui.mjs`, 4 screenshots in `design/reviews/phase-1c/`) all passed. |

## Phase 1B — Main workspace UI

2026-11-25. Phase 1A hardened and merged to `main` (`da5c07a`); Phase 1B **Verified**.

| State | Evidence |
|---|---|
| Verified | Phase 1A hardening: private `0700` runtime dir with `0600` Unix socket, exact URL/origin navigation checks, loopback-only `GHOST_BOT_DEV_URL`, WebContents + mainFrame IPC sender validation, parent-exit daemon shutdown, version-bound Codex permission evidence (`resolveCodexVerifiedEvidence`), and enhanced Electron smoke verification asserting React render + preload IPC + zero console errors. Merged to `main` (`da5c07a`). |
| Verified | Built modular three-panel React workspace in `apps/desktop/src/` (`LeftSidebar`, `ChatHeader`, `MessageList`, `ChatComposer`, `RightPanel`, `DiffPreviewModal`, `SettingsModal`, `BotAvatar`) matching `design/references/workspace-dark.png` and `design/tokens.json`. |
| Verified | Implemented 12-preset `BotAvatar` with 7 states (`idle`, `thinking`, `working`, `approval`, `sleeping`, `completed`, `error`), `prefers-reduced-motion` + manual toggle, Light/Dark/System themes, draggable + keyboard sidebar resize/collapse, and Zod-validated `localStorage` UI preferences. |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (27/27 tests including `UiPreferencesSchema` bounds & storage fallback), `pnpm build`, Electron smoke test, and extended Playwright UI verification (`scripts/verify-phase-1b-ui.mjs`: 0 console errors, no horizontal overflow across `1920x1080`, `1440x900`, `1366x768`, `960x640`, IME composition guard, Escape/Tab focus trap & restoration, reload persistence, 12 presets, 7 states) all passed. Captured 6 review screenshots under `design/reviews/phase-1b/`. |

## Phase 1A — Desktop scaffold & Step 0 review hardening

2026-11-25. Step 0 merged to `main` (`87665ed`); Phase 1A **Verified**.

| State | Evidence |
|---|---|
| Verified | Step 0 hardening: `CodexAppServerAdapter` now prevents simultaneous same-thread runs, correlates notifications by `turnId`, handles pre-`turnId` cancellation, revalidates ChatGPT subscription at execution boundaries, canonicalizes symlinked workspaces (`realpath`), revokes pending approvals on cancel/completion/exit, and `verify-codex-live.mjs` asserts all mandatory checks with symlink containment. Merged to `main` (`87665ed`). |
| Verified | Scaffolded pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) with `@ghost-bot/shared-types`, `@ghost-bot/runtime-adapters` (including explicit `MockRuntimeAdapter`), `@ghost-bot/avatar`, `@ghost-bot/daemon`, and `@ghost-bot/desktop`. |
| Verified | Built `@ghost-bot/daemon` (`apps/daemon/src/server.ts`) with Unix socket + constant-time Bearer token auth, centralized error normalization + secret redaction, and graceful shutdown. |
| Verified | Built Electron main (`apps/desktop/electron/main.ts`), CJS sandboxed preload (`apps/desktop/electron/preload.cts`), and React+Vite renderer (`apps/desktop/src/`) with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, restrictive CSP, sender/Zod IPC validation, blocked external navigation, and Fedora GTK3/Wayland switches (`gtk-version=3`, `ozone-platform-hint=auto`). |
| Tested | `pnpm lint`, `pnpm typecheck`, `pnpm test` (23/23 tests), `pnpm build`, and Fedora Electron+daemon smoke launch (`GHOST_BOT_SMOKE_EXIT=1`) all passed with exit code 0. |

## Phase 0B & 0C — Authenticated Codex integration and security verification

2026-11-25. Phase 0 exit gate **PASS**.

| State | Evidence |
|---|---|
| Verified | Built reusable `JsonRpcStdioClient` (`packages/runtime-adapters/json-rpc-client.ts`) and `CodexAppServerAdapter` (`packages/runtime-adapters/codex/codex-app-server.ts`) against Codex App Server 0.172.0 protocol schema. |
| Verified | Authenticated dedicated persistent Codex profile (`~/.config/ghost-bot/codex-profile`) via official ChatGPT device-code flow without modifying `~/.codex` or inheriting API keys. Confirmed `accountType: "chatgpt"`, `planType: "plus"`, 10 discovered models, and live rate-limit windows (`300m` at 7%, `10080m` at 13%). |
| Verified | Live `node scripts/verify-codex-live.mjs` passed all boundary and lifecycle checks on `gpt-6.2-sol`: streaming (`roStreamed: true`), read-only file read (`roReadMatched: true`), denied write in read-only (`readOnlyDeniedWriteClean: true`), workspace-contained write (`workspaceWriteSucceeded: true`), outside-workspace write blocked including `/tmp` via `excludeSlashTmp: true` (`outsideWriteBlocked: true`), approval request and rejection with no side effect (`sawApprovalRequest: true`, `rejectedApprovalNoSideEffect: true`), turn cancellation (`cancellationVerified: true`), and session resume continuity (`sessionContinuityVerified: true`). |
| Tested | `npm test` passed 16/16 offline tests across `tests/phase-zero.test.ts`, `tests/json-rpc-client.test.ts`, and `tests/codex-adapter.test.ts`. Strict TypeScript check (`tsc --noEmit --strict`) passed with 0 errors. |
| Verified | OpenClaw Gateway loopback probe (`openclaw gateway probe --json`) confirmed `ws://127.0.0.1:18789` reachable with `role: "operator"`, `scopes: ["operator.read"]`, `capability: "read_only"`. |
| Blocked | Live Ollama discovery (`127.0.0.1:11434` / binary absent) and live Kimi ACP (`kimi` CLI absent). Claude subscription login remains blocked pending vendor approval. |
| Implemented | [ADR 0004](adr/0004-codex-jsonrpc-and-sandbox-containment.md) documenting JSON-RPC transport and `excludeSlashTmp` containment. |

## Phase 0A — Starter audit and runtime discovery

2026-11-25. Local baseline completed.

| State | Evidence |
|---|---|
| Verified | Audited starter files and three screenshots. Chrome headless loaded Chief of Staff, demo approval and offline composer. Preserved prototype behavior, design tokens and twelve SVG presets. |
| Verified | Initialized `main` and pushed starter commit `4af838c` to the authorized private repository. |
| Verified | Node 24.22.3, Codex 0.172.0 and OpenClaw CLI 2026.11.8 (2d4ab29). |
| Tested | `npm test` passed four offline tests. Strict TypeScript check and JavaScript syntax checks passed. |
