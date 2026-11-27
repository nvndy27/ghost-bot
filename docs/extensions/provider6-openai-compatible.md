# Provider.6: Shared OpenAI-Compatible Runtime Integration

- **Branch**: `feat/provider6-openai-compatible` (branched from `d13e686`)
- **Migrations**: `0001`–`0013` preserved unchanged (non-secret metadata stored in `settings`; OpenRouter API key stored in `ghost-bot.provider` OS Secret Service).
- **Zero live inference, paid API spend, software installation, or host configuration changes performed.**

## 1. Shared Transport & Provider Adapters
- **Shared Transport (`packages/runtime-adapters/openai-compat/openai-compatible-transport.ts`)**: Implements `OpenAiCompatibleRuntimeBase` with endpoint validation before every request, `redirect: 'error'` + explicit `3xx` rejection, fragmented UTF-8 SSE parsing, malformed frame rejection, idle-stream & total-duration timeouts, abort-raced `readWithAbortAndIdle()`, `maxAttempts: 1` (zero hidden retries), tool-call/function-call delta rejection (`OPENAI_COMPAT_TOOLS_UNSUPPORTED`), private reasoning suppression (`reasoning`, `reasoning_content`, `thinking`), non-cumulative `usage` emission (`getUsage() -> null`), `length` (`OPENAI_COMPAT_MAX_TOKENS`), `content_filter` (`OPENAI_COMPAT_CONTENT_FILTERED`), and `OPENAI_COMPAT_UNKNOWN_TERMINATION` on incomplete streams.
- **LM Studio (`lmstudio`)**: Default loopback `http://127.0.0.1:1234/v1` (`assertLoopbackOpenAiCompatBaseUrl`). `lms`/`lmstudio` not installed and `127.0.0.1:1234` unreachable on host.
- **llama.cpp (`llamacpp`)**: Default loopback `http://127.0.0.1:8080/v1` (`assertLoopbackOpenAiCompatBaseUrl`). `llama-server`/`llama-cli` not installed and `127.0.0.1:8080` unreachable on host.
- **OpenRouter (`openrouter`)**: Pinned `https://openrouter.ai/api/v1` (`assertPinnedHttpsOriginUrl`), `provider: { allow_fallbacks: false }`, user-owned API key in `ghost-bot.provider` (`providerId: 'openrouter'`), rotation/deletion aborts active runs and resets authorization.

## 2. Bounded Live Acceptance Procedures
- **LM Studio / llama.cpp**: Start local server on `127.0.0.1:1234` or `127.0.0.1:8080` with one local GGUF/MLX model, confirm `GET /lmstudio/status` or `GET /llamacpp/status` reports `available: true`, enable explicit local opt-in, and run one `read-only` prompt (`maxOutputTokens <= 256`, `maxAttempts: 1`).
- **OpenRouter**: Save user-owned OpenRouter API key in Settings, enable `Authorize OpenRouter API` (cloud data-transfer + API-billing opt-in), run 1 model discovery (`GET /api/v1/models`) and 1 `read-only` prompt (`max_tokens <= 256`, `allow_fallbacks: false`, `maxAttempts: 1`).
