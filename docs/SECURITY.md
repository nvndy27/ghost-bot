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

The isolated Codex profile excludes inherited API keys and user configuration. The OpenClaw probe uses existing CLI-managed credentials and refuses a nonmatching Gateway URL. Probes emit summaries only. Never use them as a production credential broker or expose them through renderer IPC.

The preflight tests exercise deny-by-default capability selection. No execution permission mode is enabled by Phase 0 evidence. Before enabling one, test direct tool calls, native commands, plugin/MCP paths, absolute and symlinked paths, and external side effects against the actual runtime boundary.
