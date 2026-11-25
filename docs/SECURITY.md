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

## Phase 0 boundary evidence

The Codex App Server adapter (`packages/runtime-adapters/codex/codex-app-server.ts`) uses a dedicated persistent profile (`~/.config/ghost-bot/codex-profile`), never touches `~/.codex`, and strips `OPENAI_API_KEY` / `CODEX_API_KEY` from the child environment so subscription-first execution cannot silently fall back to paid API keys.

Live verification (`scripts/verify-codex-live.mjs`) confirmed:
- `read-only`: reads workspace files without modifying disk; writes are blocked and leave no side effects.
- `workspace`: writes succeed inside the canonical workspace root while writes outside the workspace (including `/tmp` and `$TMPDIR`, explicitly blocked via `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true` in `sandboxPolicy`) are prevented.
- `ask-approval`: server-initiated approval requests (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) are bound to `approvalId`, `runId`, canonical `argsHash`, and expiry; denied or mismatched decisions fail closed and produce no filesystem side effects.
- `full-access`: remains disabled by default unless explicit opt-in and verified evidence are supplied.

The OpenClaw probe uses existing CLI-managed credentials (`operator.read`, `read_only`) and refuses a nonmatching Gateway URL. Probes and verification scripts emit redacted summaries only and are never exposed through renderer IPC.
