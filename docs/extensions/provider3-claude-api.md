# Provider.3: Anthropic Claude API Integration & Targeted Core Hardening

- **Branch**: `feat/provider3-claude-api` (branched from `94a71dc`)
- **Commit 1 (Core Security Fixes)**: `edfbad18f189c05bc0441f65e2a9c9beb790f67a` (`CORE2-TERM-01` & `CORE1-SS-01`)
- **Migrations**: `0001`–`0013` preserved unchanged (provider credential metadata stored in existing `settings` table under `provider.anthropic.v1`, secret value stored exclusively in OS Secret Service).
- **Zero live inference, paid API requests, credential-validation calls, or host configuration changes performed.**

## 1. Targeted Core Security Fixes (`CORE2-TERM-01` & `CORE1-SS-01`)
- **`CORE2-TERM-01` (`apps/daemon/src/terminal/service.ts`, `apps/daemon/src/server.ts`)**:
  - Added `ScopedTerminalService.revokeByRunId()` and `revokeByBotId()` and wired `RunOrchestrator.setOnRunTerminated` plus `PATCH/DELETE /bots/:id` to revoke Scoped Terminal commands on run termination, bot deletion, permission downgrade to `read-only`, or workspace change.
  - Closed async startup race across `getCapabilities()` -> `executeInBwrap()` via `startingCommands` + `revokedRuns` + `revokedCommandIds` checks before `spawn()`, and guarded final DB updates (`WHERE id = ? AND status = 'running'`) so late callbacks cannot overwrite `'uncertain'` or `'cancelled'`.
  - Orphaned `running` rows without a tracked process are marked `'uncertain'` (`termination_confirmed = 0`) and `replayAllowed` remains `false`.
- **`CORE1-SS-01` (`apps/daemon/src/secrets/store.ts`)**:
  - Fixed `LinuxSecretServiceStore.getStatus()` fail-open fallthrough when `busctl` is missing or D-Bus/collection probes fail. Now verifies executable presence (`secret-tool`, `busctl`), `DBUS_SESSION_BUS_ADDRESS`, `org.freedesktop.secrets` D-Bus service ownership (`GetNameOwner`), and `org.freedesktop.Secret.Collection.Locked` (`b true` -> locked, `b false` -> available, any error/missing collection -> fail closed).

## 2. Official Anthropic Claude API Integration (`packages/runtime-adapters/claude/anthropic-claude-api.ts`)
- **Endpoint & Transport**: Hard-pinned to `https://api.anthropic.com` (`anthropic-version: 2023-06-01`) via `assertApprovedAnthropicUrl()`, enforcing `https:`, no credentials in URL, `redirect: 'error'` + explicit `3xx` rejection, and injectable `transport` for offline testing only.
- **Credentials & Isolation**: Added `ProviderSecretCoordinate` (`service: 'ghost-bot.provider'`) in `SecretStore` (`apps/daemon/src/secrets/store.ts`), completely separate from `ghost-bot.mcp`. Never reads `ANTHROPIC_API_KEY`, `~/.claude`, or browser cookies. Rotating or deleting the key increments `credentialGeneration` and resets `executionAuthorized = false`.
- **Execution & Bounds**: Tool-free `read-only` chat only (`tools` omitted, `tool_use` blocks and attachments rejected), `maxConcurrentRuns = 1`, `maxHistoryMessages = 24`, `maxHistoryBytes = 48 KiB`, `maxOutputTokens = 4096` (ceiling `8192`), `maxDurationMs = 120_000`, `maxStreamBytes = 2 MiB`, `maxAttempts = 1` (zero automatic retries).
- **SSE & Usage**: Parses `message_start`, `content_block_start`, `content_block_delta` (`text_delta`), `message_delta`, `message_stop`, and `error`. Maps `input_tokens` / `output_tokens` to `usage.updated` (`source: 'provider'`, `windows: []`); `getUsage()` returns `null`. Incomplete streams emit `CLAUDE_UNKNOWN_TERMINATION` (noting billing outcome is uncertain).

## 3. Official Claude Code CLI Compatibility Assessment (Read-Only)
- **Local Observation**: `/home/nguyenduy/.local/bin/claude` (`2.1.331 (Claude Code)`) is installed on the host. No live prompts were executed and no `~/.claude` files were read or modified.
- **Compliance Distinction**:
  - *Direct official CLI usage*: User runs `claude` interactively in their own terminal under Anthropic's consumer/commercial terms.
  - *Claude Agent SDK / Messages API with API-key auth*: Supported third-party integration path using user-owned `x-api-key` credentials billed to the user's Anthropic API account (implemented here).
  - *Hosting unmodified Claude Code binary / third-party subscription credential mediation*: Not supported without explicit Anthropic vendor approval; reading, extracting, or proxying Claude.ai subscription tokens or Claude Code auth files is prohibited and remains gated/disabled (`capabilities.claudeCodeCli: false`).

## 4. Bounded One-Turn Live Acceptance Procedure (For Explicit User Authorization)
1. Configure a valid user-owned Anthropic API key in Settings -> Accounts & Providers (`Save key` -> stored in `ghost-bot.provider` OS Secret Service).
2. Explicitly enable `Authorize API-billed chat` (`PUT /claude/authorization` -> `authorized: true`).
3. Verify expected billing: `maxAttempts: 1`, `max_tokens <= 256`, single read-only prompt billed to the user's Anthropic API account.
4. Submit one short prompt, verify `message.delta`, `usage.updated` (`source: 'provider'`), and `run.completed`.
5. Submit a second prompt and invoke `cancelRun` mid-stream; verify `run.cancelled` and note that local abort does not guarantee zero provider-side token charges.
