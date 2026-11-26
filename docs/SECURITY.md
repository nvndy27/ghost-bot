# Security and privacy requirements

Treat model outputs, webpages, mail, attachments and MCP responses as untrusted data, never authority. Threats: prompt injection, malicious tools, path traversal/symlinks, command injection, cross-agent data leaks, token theft, Electron renderer compromise, remote gateway exposure, runaway tasks and spending.

## Permissions
Read Only: only validated read operations; no arbitrary shell, write or network side effects. Ask Approval (default): scoped read actions, approval before privileged action. Workspace Access: read/write within explicitly granted canonical directory, sandboxed execution; network and sensitive external actions separately approved. Full Access: deliberate user opt-in to user-level host access for compatible runtime, never root by default. External send/post/purchase/destructive operations retain separate approval. Deny unsupported modes; enforce through sandbox/runtime and policy broker. Resolve real paths and symlinks, protect against TOCTOU, avoid shell interpolation. No elevation by model.

Approval binds run, tool, exact arguments/diff hash, scope, expiry and decision; single use; revalidate after approval; deny on timeout/restart unless safely reissued. Show actual command/target and impact. Audit outcomes with secret redaction. No auto-click approval. Stop and revoke actions cancel future work; disclose if external side effects cannot be undone.

## Credentials / data
Use official auth or OS keyring, avoid plaintext DB, renderer or logs. No cookie/password harvesting. If keyring locked/unavailable, fail securely. Separate memory per agent, explicit team sharing, user review/delete/export, retention options. Sanitize Markdown, disable active HTML and remote image fetching by default, validate attachments and custom SVG (prefer re-encoding). Never persist hidden chain of thought. Redact event payloads, shell logs, HTTP headers and screenshots where possible.

## Electron & tools
contextIsolation, sandbox, nodeIntegration:false, restrictive CSP, validate IPC sender and inputs; no generic execute IPC. Deny navigation/new windows except allowlisted safe links. Loopback or Unix socket authenticated; no default public exposure. Rootless sandbox with explicit mounts, limited CPU/memory/time/network, independent browser profiles, no host credential mounts. MCP install is consented, pinned/versioned, scoped and audited. Tool calls from unattended routines use least privilege, stop on approval/limits, never bypass.

## Meeting assistant
Only with participant awareness/consent and platform-supported integration; opt-in recording, transcript retention and deletion controls. No covert recording.

## Phase 1D Settings & Runtime Bridge boundary

- `SettingsRepository` persists only non-secret user preferences (`general`, `appearance`, `personalization`, `permissions`, `privacy`) under `app.settings.v1`; credentials, access tokens, and refresh tokens are never stored in SQLite or exposed to renderer state. Mandatory secret redaction (`redactSecrets`, `redactStructuredValue`) is always enforced and cannot be disabled by the user; `privacy.redactLogs` controls optional extra diagnostic masking only.
- `RuntimeRegistry` and `RuntimePolicyBroker` expose metadata-only endpoints (`GET /runtime/snapshot`, `GET /providers`) with request deduplication, 30s TTL caching, runtime generation & account-switch cache invalidation, secret redaction, and zero model inference (`turn/start` is not exposed in Phase 1D).
- `RuntimePolicyBroker` binds verified permission evidence to the exact verified Codex version set (`0.172.0`) and fails closed on unverified older or newer versions, `full-access`, `mock` execution, `apiKey` accounts, and non-canonical workspaces. Dedicated `~/.config/ghost-bot/codex-profile` uses `0600` `auth.json` managed by official Codex CLI login without touching `~/.codex`.

## Phase 1C persistence and custom SVG boundary

- SQLite persistence (`ghost-bot.sqlite`, `-wal`, `-shm`) is owned exclusively by `@ghost-bot/daemon` under a canonicalized `0700` data directory with `0600` file permissions, separate from the `0700` Unix socket runtime directory. Foreign keys and `BEGIN IMMEDIATE` transactions are enforced on every connection.
- Custom SVG avatar imports (`packages/avatar/svg-sanitizer.ts`) are validated at the daemon boundary using `isomorphic-dompurify` plus an explicit pre- and post-parse allowlist: max 32 KB, max 150 elements, max nesting depth 32, max attribute length 8192, no duplicate attributes, no XML DTD/ENTITY/comment/CDATA declarations, no `<script>` / `<foreignObject>` / `<image>` / `<use>` / `<animate>` / `<style>`, no `on*` event handlers, and no external URLs (`http://`, `https://`, `javascript:`, `data:` except the exact `xmlns="http://www.w3.org/2000/svg"` namespace). Approved SVGs are stored and rendered solely as inert `data:image/svg+xml;base64,...` `<img>` sources without `dangerouslySetInnerHTML`.
- Bot workspace paths are validated and canonicalized (`realpath` + directory `stat`) at the daemon boundary; NUL bytes, `..` traversal, relative paths, and non-existent directories are rejected. `full-access` permission remains rejected at both Zod IPC schemas (`BotPermissionSchema`) and daemon persistence routes.

## Phase 0 boundary evidence

The Codex App Server adapter (`packages/runtime-adapters/codex/codex-app-server.ts`) uses a dedicated persistent profile (`~/.config/ghost-bot/codex-profile`), never touches `~/.codex`, and strips `OPENAI_API_KEY` / `CODEX_API_KEY` from the child environment so subscription-first execution cannot silently fall back to paid API keys.

Live verification (`scripts/verify-codex-live.mjs`) confirmed:
- `read-only`: reads workspace files without modifying disk; writes are blocked and leave no side effects.
- `workspace`: writes succeed inside the canonical workspace root (`approvalPolicy: 'on-request'` allows in-workspace writes without prompting while prompting for external/untrusted actions); writes outside the workspace (including `/tmp`, `$TMPDIR`, and symlinks pointing outside, explicitly blocked via `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true` in `sandboxPolicy`) are prevented.
- `ask-approval`: server-initiated approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) are bound to `approvalId`, `runId`, canonical `argsHash`, and expiry; denied, cancelled, or mismatched decisions fail closed and produce no filesystem side effects. Note that Codex's `untrusted` policy governs untrusted commands/external actions rather than guaranteeing every individual in-workspace write prompts.
- `full-access`: remains disabled by default unless explicit opt-in and verified evidence are supplied.

The OpenClaw probe uses existing CLI-managed credentials (`operator.read`, `read_only`) and refuses a nonmatching Gateway URL. Probes and verification scripts emit redacted summaries only and are never exposed through renderer IPC.

## Phase 2E Multi-Runtime & Recovery Hardening
- **Startup crash recovery**: `RunOrchestrator.reconcileOnStartup()` reconstructs durable `sessionsWithUnconfirmedStop` quarantine (`execution.quarantinedSessions.v1`) for all non-terminal live provider states (`starting`, `running`, `awaiting_approval`, `cancelling`) while leaving `queued` and `mock` runs unquarantined.
- **Process termination evidence**: `JsonRpcClient.close()` waits for actual child exit (`exitInfo !== null`) and rejects with `TRANSPORT_ERROR` if `SIGKILL` fails; `RuntimeRegistry.closeOwnedClient()` throws `RUNTIME_TERMINATION_FAILED` so quarantine is preserved on termination failure.
- **OpenClaw & Ollama boundaries**: `OpenClawGatewayAdapter` enforces loopback `ws://`/`wss://` URLs, `1 MB` CLI `maxBuffer`, credential redaction on error details, non-termination of external Gateways, and fail-closed `RuntimePolicyBroker` gating for live execution. `OllamaLocalAdapter` enforces loopback `http://`/`https://` URLs, `read-only` tool-free execution, `32 KB` / `24`-turn bounded history, and `2 MB` stream limits.
- **Workspace containment note**: Phase 2C live verification confirmed `Approve once` / `Deny` and an unchanged outside `canary.txt`; deterministic unit tests verify `excludeSlashTmp: true`, `excludeTmpdirEnvVar: true`, `networkAccess: false`, and privilege-escalation denial. Live attempt-and-block testing of symlink escapes or post-approval network access was not separately re-run.

## Phase 3D.1 Memory Security & Privacy Boundary
- `MemoryService` (`apps/daemon/src/memory/service.ts`) constructs `MemoryAuthContext` exclusively inside the daemon from persisted `agents`/`sessions` ownership and canonicalized workspace paths; renderer-supplied `userId` or authorization flags are rejected at Zod IPC boundaries.
- `MemorySettingsSchema` defaults `automaticRetrieval: false`, `includeUserWide: false`, and `externalProviderConsent: false`. Non-mock runtimes require `externalProviderConsent === true` before memory context is attached; once sent to an external provider, local deletion cannot retroactively remove provider-retained data (users must start a New chat to avoid reusing an existing provider thread).
- Retrieved records are wrapped in `untrusted_memory_reference_data` (`authority: "none"`), revalidated at dispatch (with post-preparation cancellation checks), and never elevated into `baseInstructions` or persisted in `run_events` or user `messages`. `BotRepository.deleteBot()` and `memoryService.archiveMemoriesForBotInTx()` execute in one SQLite transaction.
