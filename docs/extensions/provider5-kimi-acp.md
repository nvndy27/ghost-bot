# Provider.5: Kimi Code ACP Runtime Integration

- **Branch**: `feat/provider5-kimi-acp` (branched from `c65a621`)
- **Commit 1 (Shared Provider Security Fixes)**: `42b708b40b78f1cc5b471f1908f5218e14d4ee68`
- **Migrations**: `0001`–`0013` preserved unchanged.
- **Zero live inference, paid requests, CLI installation, unauthorized login, or host configuration changes performed.**

## 1. Official Kimi Runtime & ACP Protocol Discovery
- **Host CLI Availability**: `kimi` CLI is not installed on the host (`which kimi` not found); actual runtime interoperability with a live `kimi acp` binary is therefore unverified on this host.
- **ACP Contract**: `kimi acp` speaks JSON-RPC 2.0 over `stdin`/`stdout` (internal logs routed to `stderr`), awaiting `initialize` (`protocolVersion: 1`), `session/new` / `session/load`, `session/prompt`, `session/cancel`, `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`), and `session/request_permission` reverse-RPCs.

## 2. Adapter, Auth & Safety Boundaries (`packages/runtime-adapters/kimi/kimi-acp.ts`)
- **Capability & Framing Bounds**: Declares `fs: { readTextFile: false, writeTextFile: false }` and `terminal: false`; rejects unsupported `fs/*` and `terminal/*` reverse-RPCs (`-32601`). Enforces `1 MiB` JSON-RPC framing, `64 KiB` stderr bound, `16` pending requests, `120s` timeout, and `2 MiB` stream limit.
- **Authentication**: Guides users to run `kimi login` in their own terminal; Ghost Bot never reads Kimi token files, OAuth refresh tokens, or browser cookies, and never fabricates subscription plans or quotas (`getUsage() -> null`).
- **Permissions & Lifecycle**: Strips `allow_always` options from `session/request_permission`, correlates `approvalId` + `runId` + `argsHash`, suppresses `agent_thought_chunk` reasoning, rejects concurrent prompts on the same session (`KIMI_SESSION_BUSY`), and quarantines sessions on unexpected process exit (`KIMI_UNKNOWN_TERMINATION`, no automatic replay).
- **Policy Gate**: `RuntimePolicyBroker.authorizeKimiAcpExecution()` keeps live Kimi execution gated by default (`allowed: false`) until CLI availability, ACP v1 handshake, `kimi login` auth, runtime containment, and explicit opt-in are verified.

## 3. Shared Provider Security Review Fixes (Commit 1: `42b708b`)
- Added immediate pre-request revalidation of `credentialGeneration`, `accountRef`, `isExecutionAuthorized()`, and `resolveApiKey()` right before outgoing HTTP dispatch in both `AnthropicClaudeApiAdapter` and `GoogleGeminiApiAdapter`.
- Added proactive `abortActiveRuns()` on credential rotation, deletion, or authorization revocation in `apps/daemon/src/server.ts` + `RuntimeRegistry.abortProviderRuns()`.
- Added abort-raced `readWithAbort()` in both adapters so stalled SSE streams cancel promptly without hanging.

## 4. Bounded Live Acceptance Procedure (For Later Explicit User Authorization)
1. Install official Kimi Code CLI and authenticate with `kimi login` in your terminal.
2. Verify `GET /kimi/status` reports `cliAvailable: true`, `acpProtocolSupported: true` (`protocolVersion: 1`), and `authenticated: true`.
3. Authorize bounded `ask-approval` execution on a single canonical workspace bot (`read-only` remains gated unless Kimi-side containment is verified).
4. Submit one short prompt, verify `message.delta`, single-use `approval.requested` (`allow_once`/`deny`), and `run.completed`, then test `cancelRun` on a second prompt.
