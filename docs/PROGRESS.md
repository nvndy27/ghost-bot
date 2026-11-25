# Progress log

## Phase 0B & 0C — Authenticated Codex integration and security verification

2026-11-25. Phase 0 exit gate **PASS**.

| State | Evidence |
|---|---|
| Verified | Built reusable `JsonRpcStdioClient` (`packages/runtime-adapters/json-rpc-client.ts`) and `CodexAppServerAdapter` (`packages/runtime-adapters/codex/codex-app-server.ts`) against Codex App Server 0.172.0 protocol schema. |
| Verified | Authenticated dedicated persistent Codex profile (`~/.config/ghost-bot/codex-profile`) via official ChatGPT device-code flow without modifying `~/.codex` or inheriting API keys. Confirmed `accountType: "chatgpt"`, `planType: "plus"`, 10 discovered models, and live rate-limit windows (`300m` at 7%, `10080m` at 13%). |
| Verified | Live `node scripts/verify-codex-live.mjs` passed all boundary and lifecycle checks on `gpt-6.2-sol`: streaming (`roStreamed: true`), read-only file read (`roReadMatched: true`), denied write in read-only (`readOnlyDeniedWriteClean: true`), workspace-contained write (`workspaceWriteSucceeded: true`), outside-workspace write blocked including `/tmp` via `excludeSlashTmp: true` (`outsideWriteBlocked: true`), approval request and rejection with no side effect (`sawApprovalRequest: true`, `rejectedApprovalNoSideEffect: true`), turn cancellation (`cancellationVerified: true`), and session resume continuity (`sessionContinuityVerified: true`). |
| Tested | `npm test` passed 16/16 offline tests across `tests/phase-zero.test.ts`, `tests/json-rpc-client.test.ts`, and `tests/codex-adapter.test.ts`. Strict TypeScript check (`tsc --noEmit --strict`) passed with 0 errors. |
| Verified | OpenClaw Gateway loopback probe (`openclaw gateway probe --json`) confirmed `ws://127.0.0.1:18789` reachable with `role: "operator"`, `scopes: ["operator.read"]`, `capability: "read_only"`. |
| Blocked | Live Ollama discovery (`127.0.0.1:11434` / binary absent) and live Kimi ACP (`kimi` CLI absent). Claude subscription login remains blocked pending vendor approval. |
| Implemented | [ADR 0004](adr/0004-codex-jsonrpc-and-sandbox-containment.md) documenting JSON-RPC transport and `excludeSlashTmp` containment. |

## Phase 0A — Starter audit and runtime discovery

2026-11-25. Local baseline completed.

| State | Evidence |
|---|---|
| Verified | Audited starter files and three screenshots. Chrome headless loaded Chief of Staff, demo approval and offline composer. Preserved prototype behavior, design tokens and twelve SVG presets. |
| Verified | Initialized `main` and pushed starter commit `4af838c` to the authorized private repository. |
| Verified | Node 24.22.3, Codex 0.172.0 and OpenClaw CLI 2026.11.8 (2d4ab29). |
| Tested | `npm test` passed four offline tests. Strict TypeScript check and JavaScript syntax checks passed. |
