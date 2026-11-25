# ADR 0004 — Reusable JSON-RPC stdio transport and Codex sandbox containment

Status: Accepted for Phase 0B & 0C.

## Context

The Phase 0A Codex probe used a single-request loop and relied on default `workspace-write` thread settings. During live Phase 0B/0C verification against Codex App Server 0.172.0, two findings emerged:

1. Production and test execution require concurrent request correlation, server-initiated approval handling (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`), request timeouts, `AbortSignal` cancellation, malformed payload resilience, and graceful shutdown.
2. Codex App Server's `WorkspaceWriteSandboxPolicy` defaults `excludeSlashTmp` and `excludeTmpdirEnvVar` to `false`, allowing writes to `/tmp` even when `cwd` is an isolated workspace.

## Decision

1. Implement `JsonRpcStdioClient` in `packages/runtime-adapters/json-rpc-client.ts` as a reusable newline-delimited JSON-RPC 2.0 stdio client with normalized `JsonRpcClientError` codes.
2. Implement `CodexAppServerAdapter` in `packages/runtime-adapters/codex/codex-app-server.ts` using a dedicated persistent profile (`~/.config/ghost-bot/codex-profile` by default), stripping inherited `OPENAI_API_KEY`/`CODEX_API_KEY` from the child environment, and passing explicit `sandboxPolicy` on every `turn/start`:
   - `read-only`: `{ type: 'readOnly', networkAccess: false }` with `approvalPolicy: 'on-request'`
   - `ask-approval` / `workspace`: `{ type: 'workspaceWrite', writableRoots: [resolve(workspace)], excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false }`
   - `full-access`: remains disabled unless explicit `fullAccessOptIn` and verified evidence are provided.
3. Require single-use `approvalId` + `runId` + canonical `argsHash` validation and expiry enforcement before returning `{ decision: 'accept' | 'decline' }` to Codex server requests.

## Consequences

- Writes outside the canonical workspace (including `/tmp` and `$TMPDIR`) are blocked by the Codex sandbox during live `workspace` runs.
- Unattended or mismatched approvals fail closed to `decline`.
- Secondary providers (OpenClaw native client, Kimi ACP, Ollama, Claude, Gemini) remain separate adapters gated on their own protocol and boundary verification.
