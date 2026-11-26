# Provider.2: Ollama Local Runtime Production Integration

- **Branch**: `feat/provider2-ollama-local` (branched from `d6436c60df0f4ccafdd3c26d0cbab658253ceb45`)
- **Migrations**: `0001`–`0013` preserved unchanged (no migration required).
- **Zero live inference, model downloads, `sudo`, or persistent service changes performed.**

## 1. Actual Local Environment & Hardware Discovery
- **Ollama CLI & Daemon**: `ollama` CLI not found on `PATH`, no `ollama` process running, `~/.ollama` absent, and `http://127.0.0.1:11434/api/version` unreachable (`Connection refused`).
- **Host Hardware**:
  - CPU: 12 cores
  - RAM: 13 GiB total, 4.9 GiB available (Swap: 8.0 GiB total, 1.9 GiB free)
  - GPU: NVIDIA GeForce RTX 3050 Mobile (`GA107BM`) + AMD Radeon 660M / 680M (`Rembrandt`)
  - Disk (`/home`): 130 GiB total, 76 GiB used, 53 GiB available
- **Recommended Lightweight Models (Once Ollama Is Installed)**: `qwen2.5:1.5b` or `llama3.2:1b` (Q4_K_M, ~1.0–1.3 GB) to fit comfortably within the 4.9 GiB available RAM / RTX 3050 Mobile VRAM.

## 2. Adapter Implementation (`packages/runtime-adapters/ollama/ollama-adapter.ts`)
- **Loopback & Transport Security**: `assertLoopbackOllamaUrl()` enforces `http:`/`https:` on `127.0.0.1`, `localhost`, or `::1`/`[::1]`, rejects embedded credentials, and sets `redirect: 'error'` plus explicit `3xx` status rejection on every request.
- **Official API Operations**: Supports `/api/version` (`checkAvailability`), `/api/tags` (`listModelDetails`, `listModels`), `/api/show` (`inspectModel` for `parameterSize`, `quantizationLevel`, `family`, `contextLength`, cloud detection), `/api/ps` (`listRunningModels`), `/api/chat` (`run`), `inspectLocalRuntime()`, `resumeSession()`, `inspectSession()`, `reconnect()`, and `cancel()`.
- **Local-Only & Tool-Free Enforcement**: Rejects cloud-backed models (`:cloud`, `-cloud`, `cloud/`, `remote_model`, `remote_host`), verifies installed local models in `createSession()`, enforces `permission === 'read-only'`, rejects attachments, and aborts if `message.tool_calls` is emitted.
- **Resource Limits & Error Mapping**:
  - `maxConcurrentRuns`: `1` (configurable up to `4`)
  - `OLLAMA_MAX_HISTORY_MESSAGES`: `24` turns, `OLLAMA_MAX_HISTORY_BYTES`: `32 KiB`
  - `maxOutputTokens` (`options.num_predict`): `2048` (ceiling `8192`)
  - `maxDurationMs`: `120_000` ms (`OLLAMA_TIMEOUT`)
  - `OLLAMA_MAX_STREAM_BYTES`: `2 MiB` (`OLLAMA_RESPONSE_TOO_LARGE`)
  - `OLLAMA_MAX_METADATA_BYTES`: `256 KiB`
  - `maxAttempts`: `1` (no hidden retries; incomplete streams emit `OLLAMA_UNKNOWN_TERMINATION` and are not persisted to history; request cancellation aborts the HTTP stream and does not claim GPU memory release).
- **Usage Accounting**: Maps actual `prompt_eval_count` and `eval_count` to `usage.updated` (`source: 'local'`, `windows: []`); `getUsage()` returns `null` (no fabricated subscription quotas).

## 3. Authorization & Desktop Integration
- `RuntimePolicyBroker.authorizeOllamaExecution()` gates live Ollama execution by default (`allowed: false`) unless `requestedPermission === 'read-only'`, `ollamaExecutionAuthorized === true`, `ollamaAvailable === true`, `ollamaLoopbackVerified === true`, `ollamaLocalOnlyVerified === true`, and `canonicalWorkspace` is valid.
- Added `RuntimeRegistry.getOllamaStatus()`, `GET /ollama/status`, `IPC_CHANNELS.OLLAMA_STATUS` (`ghost:ollama:status`), `OllamaStatusDtoSchema`, `window.ghostBot.getOllamaStatus()`.
- Extended `SettingsModal.tsx` (`ollama-status-card`, `ollama-auth-badge`, `ollama-gated-reason`, `ollama-models-section`) and `BotEditorModal.tsx` (`bot-runtime-select` with `'ollama'` and `bot-model-select` showing local Ollama models or unavailable status without silent mock fallback).

## 4. Bounded One-Turn Local Inference Acceptance Procedure
1. Install Ollama locally and start the loopback listener (`http://127.0.0.1:11434`), then pull a single lightweight local model (e.g., `ollama pull qwen2.5:1.5b` or `ollama pull llama3.2:1b`).
2. Confirm `GET /ollama/status` reports `available: true`, `localOnlyVerified: true`, and lists the installed non-cloud model.
3. Configure a single test bot with `runtimeId: 'ollama'`, `modelId: 'qwen2.5:1.5b'`, `permission: 'read-only'`, and explicit `ollamaExecutionAuthorized: true`.
4. Submit one short prompt with `maxOutputTokens: 256` and `maxDurationMs: 30_000`; verify `message.delta`, `usage.updated` (`source: 'local'`), and `run.completed`.
5. Submit a second bounded prompt and invoke `cancelRun` mid-stream; verify `run.cancelled`.
