# Provider.4: Google Gemini API Production Integration

- **Branch**: `feat/provider4-gemini-api` (branched from `fcded26`)
- **Migrations**: `0001`–`0013` preserved unchanged (non-secret metadata stored in `settings` under `provider.gemini.v1`; API key stored exclusively in OS Secret Service under `ghost-bot.provider`).
- **Zero live inference, API spend, unauthorized external requests, `sudo`, or host configuration changes performed.**

## 1. Selected API Contract & Adapter (`packages/runtime-adapters/gemini/google-gemini-api.ts`)
- **Selected Contract**: Official Gemini API `v1beta` (`models` + `streamGenerateContent?alt=sse`) over the newer Interactions API because `streamGenerateContent` is simpler, directly matches Ghost Bot's stateless turn-by-turn `AgentRuntime` contract, and avoids duplicating API surfaces.
- **Transport & Auth**: Pinned to `https://generativelanguage.googleapis.com`, enforces `https:`, rejects embedded credentials, unauthorized hosts/ports, `?key=` query params, and HTTP redirects (`redirect: 'error'` + `3xx` check), passing keys strictly via `x-goog-api-key`.
- **Bounds & Safety**: Tool-free `read-only` chat (`tools` omitted; `functionCall`, `executableCode`, `codeExecutionResult`, and attachments rejected), `maxConcurrentRuns = 1`, `maxHistoryMessages = 24`, `maxHistoryBytes = 48 KiB`, `maxOutputTokens = 4096` (ceiling `8192`), `maxDurationMs = 120_000`, `maxStreamBytes = 2 MiB`, `maxAttempts = 1` (zero automatic retries).
- **Streaming, Safety & Usage**: Handles `promptFeedback.blockReason`, `SAFETY`/`RECITATION`/`BLOCKLIST`/`PROHIBITED_CONTENT`/`SPII` (`GEMINI_SAFETY_BLOCKED`), `MAX_TOKENS` (`GEMINI_MAX_TOKENS`, never falsely reported as `run.completed`), empty candidates (`GEMINI_EMPTY_RESPONSE`), incomplete streams (`GEMINI_UNKNOWN_TERMINATION`), hidden `thought: true` parts (never emitted/persisted), and non-cumulative `usageMetadata` snapshot emission (`usage.updated` once at terminal time; `getUsage() -> null`).

## 2. Targeted Security Review Findings & Hardening
- Hardened mid-stream credential rotation checks in both `AnthropicClaudeApiAdapter` and `GoogleGeminiApiAdapter` so rotating a key during an active SSE stream immediately aborts and emits `*_CREDENTIAL_ROTATED`.
- Added cleanup of stale `accountRef` secrets in `apps/daemon/src/server.ts` when `accountRef` changes on `PUT /claude/credential` or `PUT /gemini/credential`, plus `accountRef` session binding in `GoogleGeminiApiAdapter`.
- `P1-OC-01` / `P1-OC-02`: Not present in repository; no OpenClaw live execution changes were needed.

## 3. Gemini CLI Assessment (Read-Only)
- `gemini` CLI is not installed on the host; `GEMINI_API_KEY` and `GOOGLE_API_KEY` are unset.
- Per Google's transition documentation, consumer Google-account Gemini Code Assist / CLI login flows are discontinued (`capabilities.geminiCli: false`). Compliant integration uses user-owned Gemini API keys via `x-goog-api-key` (never browser cookies or OAuth token extraction).

## 4. Bounded One-Turn Live Acceptance Procedure (Explicit Request Budget: 2 Requests)
1. Save a user-owned Gemini API key in Settings -> Accounts & Providers (`ghost-bot.provider`, `providerId: 'gemini'`).
2. Enable `Authorize Gemini API` (`PUT /gemini/authorization` -> `authorized: true`).
3. **Request 1 (Model Discovery)**: `GET /v1beta/models` (1 request) to populate `generateContent`-capable models.
4. **Request 2 (Bounded Chat)**: Send 1 short `read-only` prompt with `maxOutputTokens: 256` and `maxAttempts: 1` (1 request; total budget = **2 HTTP requests**). Verify `message.delta`, `usage.updated`, and `run.completed`.
