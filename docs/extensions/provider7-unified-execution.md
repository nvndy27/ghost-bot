# Provider.7: Unified Multi-Provider Execution Integration

Date: 2026-11-27
Branch: `feat/provider7-unified-execution` (stacked on `feat/provider6-openai-compatible` @ `5d57c39`)

## Summary of Changes

1. **Resolved HTTP 501 `LIVE_INFERENCE_DISABLED` execution gap**:
   - `RuntimeRegistry` (`apps/daemon/src/runtime/registry.ts`): added persistent adapter ownership (`registerPersistentAdapter`, `getPersistentAdapter`, `getUnifiedExecutionAdapter`), wired `abortProviderRuns()` and `getLocalOpenAiCompatStatus()` to persistent adapters, and ensured `stop()` disconnects all persistent adapters.
   - `GhostBotDaemon` (`apps/daemon/src/server.ts`): registers persistent instances of `AnthropicClaudeApiAdapter`, `GoogleGeminiApiAdapter`, `OpenClawGatewayAdapter`, `OllamaLocalAdapter`, `KimiAcpAdapter`, `LmStudioLocalAdapter`, `LlamaCppLocalAdapter`, and `OpenRouterApiAdapter` on `start()` (with `testProviderAdapters` override hook for offline tests); added `buildProviderPolicyInput()` and wired `updateBaseUrl()` + `configGeneration` invalidation on `PUT /lmstudio/config` and `PUT /llamacpp/config`.
   - `RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`): replaced the Codex-only gate with `UNIFIED_PROVIDER_RUNTIMES` + `unifiedPreflight` validation (`SESSION_RUNTIME_MISMATCH`, `INVALID_WORKSPACE`, `RuntimePolicyBroker.authorize`, `ACCOUNT_MISMATCH`) and `executeUnifiedProviderRun()` (pre-dispatch policy revalidation, canonical `messages` history reconstruction for stateless HTTP/in-memory-session providers after daemon restart, bounded streaming buffer flush, cancellation, and uncertain-outcome quarantine without automatic replay). Codex `executeCodexRun()` and mock execution remain unchanged.

2. **Targeted Provider.6 Residual Hardening**:
   - `packages/runtime-adapters/openai-compat/openai-compatible-transport.ts`: added `readBoundedResponseText()` for incremental streaming metadata limits before buffering, tightened `assertPinnedHttpsOriginUrl()` to reject unexpected paths/queries/fragments, removed `allowNetworkDiscovery` bypass for `kind === 'cloud'` in `listModels()`, added `configGeneration` to `CompatSessionState` and `updateBaseUrl()` to block `A -> B -> A` stale session resurrection, suppressed post-`[DONE]` SSE frames, and rejected unexpected `finish_reason`.
   - `packages/runtime-adapters/claude/anthropic-claude-api.ts` and `packages/runtime-adapters/gemini/google-gemini-api.ts`: switched `listModels()` to incremental `readBoundedResponseText()` and removed `allowNetworkDiscovery` unauthenticated bypass.

3. **Verification**:
   - `tests/provider7-unified-execution.test.ts`: full `GhostBotDaemon -> RunOrchestrator -> RuntimePolicyBroker -> adapter` acceptance suite covering fail-closed 403 denials across gated/unavailable runtimes (`openclaw`, `ollama`, `kimi-acp`, `llamacpp`, `claude-api`, `gemini-api`, unauth `openrouter`), real loopback HTTP LM Studio streaming + restart canonical-history reconstruction + `A -> B -> A` `ACCOUNT_MISMATCH` 409 + stalled stream cancellation + `OPENAI_COMPAT_UNKNOWN_TERMINATION` quarantine without auto-replay, synthetic `OpenRouterApiAdapter` execution, and Provider.6 residual checks.
   - `scripts/verify-provider7-unified-execution-desktop.mjs`: full Electron -> IPC -> Daemon -> RunOrchestrator -> RuntimePolicyBroker -> real loopback HTTP LM Studio E2E (fail-closed unauthorized OpenRouter denial, loopback LM Studio streaming, reload persistence, and stalled stream cancellation).
