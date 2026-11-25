# Provider integration matrix

Evidence reviewed 2026-11-25. A catalog, authenticated handshake, and actual model execution are separate checks.

| Route | Evidence | Status and limitations |
|---|---|---|
| OpenAI via Codex App Server | [Official App Server protocol](https://learn.chatgpt.com/docs/app-server) and generated 0.172.0 JSON schema (`codex app-server generate-json-schema`). | **Verified** on Codex CLI 0.172.0 with dedicated ChatGPT `plus` profile (`~/.config/ghost-bot/codex-profile`). Phase 0 verified `initialize`, `account/read`, `model/list`, `account/rateLimits/read`, streaming `turn/start`, `turn/interrupt`, `thread/resume`, and sandboxing. Phase 1D verified the full Electron → IPC → Daemon → Policy Broker → Codex metadata bridge (`status: available`, `planType: plus`, 10 models, 2 rate-limit windows) without inference. `full-access` remains disabled. |
| OpenClaw Gateway | [Handshake](https://docs.openclaw.ai/gateway/protocol/handshake) and [CLI](https://docs.openclaw.ai/cli/gateway) document protocol negotiation, device challenge, scoped operator access and RPCs. | **Verified** for loopback health and read-only gateway probe (`ws://127.0.0.1:18789`, `role: operator`, `scopes: ["operator.read"]`, `capability: read_only`) on CLI 2026.11.8 (2d4ab29). Native WebSocket adapter, device pairing, session streaming, and execution enforcement remain **Not Started**. |
| Anthropic Claude | [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) documents API key authentication and requires prior approval for offering Claude.ai login or rate limits in third-party products. | **Blocked** for subscription login pending explicit vendor approval. API key route documented and **Not Started**. Separate opt-in required. |
| Google Gemini | [Google transition announcement](https://github.com/google-gemini/gemini-cli/discussions/28017) ended Gemini CLI service for individual free, Pro and Ultra accounts on June 18, 2026. Enterprise and API key routes remain. [Gemini API auth](https://ai.google.dev/gemini-api/docs/api-key). | **Not Started**. API support requires separate opt-in. |
| Moonshot Kimi Code | [Official CLI release notes](https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html) and docs specify `kimi login` (RFC 8628 device-code OAuth) and `kimi acp` (JSON-RPC over stdio). | **Blocked** for live verification (`kimi` CLI not installed locally). Non-blocking for Phase 1. |
| Ollama | Official loopback [version](https://docs.ollama.com/api/version) and [model list](https://docs.ollama.com/api/tags) endpoints. | **Blocked** for live verification. No installed CLI or listener at `127.0.0.1:11434`. Discovery probe implemented. Non-blocking for Phase 1. |
| LM Studio, llama.cpp, OpenRouter | Deferred. | **Not Started**. |

Unknown quota stays `null`. Count observed or estimated local usage separately and label its source. Never substitute an API key account for a subscription account without user opt-in.
