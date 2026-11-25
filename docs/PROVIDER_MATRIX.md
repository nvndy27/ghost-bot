# Provider integration matrix

Evidence reviewed 2026-11-25. A catalog, authenticated handshake, and actual model execution are separate checks.

| Route | Evidence | Status and limitations |
|---|---|---|
| OpenAI via Codex App Server | [Official App Server protocol](https://learn.chatgpt.com/docs/app-server) documents stdio initialization, managed ChatGPT auth, model discovery, quota RPCs, approvals and turn interruption. | **Verified** for isolated local initialize, account response and catalog on 0.172.0. Signed-out catalog returned 11 entries with 62 effort options total. User eligibility, quota, inference, cancellation and sandbox behavior remain unverified. |
| OpenClaw Gateway | [Handshake](https://docs.openclaw.ai/gateway/protocol/handshake) and [CLI](https://docs.openclaw.ai/cli/gateway) document protocol negotiation, device challenge, scoped operator access and RPCs. | **Verified** for the configured CLI's loopback health RPC on CLI 2026.11.8 (2d4ab29). Gateway version, auth method, delegated scopes, model access, session streaming, and permission enforcement remain unverified. Use a separately scoped identity for a future native adapter. |
| Anthropic Claude | [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) documents API key authentication and requires prior approval for offering Claude.ai login or rate limits in third-party products. | **Blocked** for subscription login pending explicit vendor approval. API key route documented and **Not Started**. Separate opt-in required. |
| Google Gemini | [Google transition announcement](https://github.com/google-gemini/gemini-cli/discussions/28017) ended Gemini CLI service for individual free, Pro and Ultra accounts on June 18, 2026. Enterprise and API key routes remain. [Gemini API auth](https://ai.google.dev/gemini-api/docs/api-key). | **Not Started**. Investigate supported Antigravity integration and third-party eligibility before promising subscription access. API support requires separate opt-in. |
| Moonshot Kimi Code | [Official CLI release notes](https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html) document ACP and effort configuration. | **Not Started** for live ACP negotiation. Verify installed version, official Kimi login, account entitlement, dynamic session config, permissions, and quota disclosure. |
| Ollama | Official loopback [version](https://docs.ollama.com/api/version) and [model list](https://docs.ollama.com/api/tags) endpoints. | **Blocked** for live verification. No installed CLI or listener at 127.0.0.1:11434. Discovery probe implemented. Validate model-specific chat behavior, streaming and cancellation separately. |
| LM Studio, llama.cpp, OpenRouter | Deferred. | **Not Started**. |

Unknown quota stays null. Count observed or estimated local usage separately and label its source. Never substitute an API key account for a subscription account without user opt-in.
