# Provider integration matrix — hypotheses, NOT verified

The subscription-first goal does not imply consumer chat entitlements equal coding/runtime/API entitlements. Exact model lists, effort values, quotas, refresh times and eligibility must be discovered. Links below are starting points for official research, not evidence that an integration currently works.

| Provider | Candidate supported route | P0 status | Discovery / constraints |
|---|---|---|---|
| OpenAI ChatGPT | Codex App Server, official account auth | unverified | initialize, auth state, model list, effort, rate-limit fields, approval and sandbox; Codex entitlement may differ from ChatGPT chat |
| OpenClaw | Gateway RPC / configured agents | unverified | protocol version, scopes, session, agent, tool and approval capabilities; validate supported providers and license |
| Anthropic Claude | documented Claude integration / API | unverified | verify whether a third-party personal client may use subscription auth; if not, API only with user opt-in |
| Google Gemini | official Gemini API / eligible coding runtime | unverified | verify current account/plan support; consumer subscription may not provide API usage |
| Moonshot Kimi | Kimi Code / ACP if supported; API | unverified | verify plan, auth, ACP version, model and quota support |
| Local | Ollama, LM Studio, llama.cpp | unverified | model discovery, streaming, tools vary per model; local resource limits |
| OpenRouter | official API | deferred | explicit opt-in, cost accounting |

Research starting points: https://github.com/openclaw/openclaw ; https://docs.openclaw.ai/ ; https://github.com/openai/codex ; https://developers.openai.com/codex/ ; https://docs.anthropic.com/ ; https://ai.google.dev/ ; https://github.com/MoonshotAI ; https://docs.ollama.com/ ; https://lmstudio.ai/docs/ ; https://agentclientprotocol.com/ . Verify current canonical URLs and applicable terms before implementation.

For each probe record date, official URL, installed version, plan type (never account identifiers), auth mechanism, capabilities, exact observed response fields (redacted), pass/fail/blocked, limitations. No hidden endpoints or cookie extraction. No silent fallback. Quota unsupported → null and UI 'Unavailable'; locally counted tokens separate from provider quota.
