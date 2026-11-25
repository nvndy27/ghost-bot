# Next steps

Phase 0 exit gate is **PASS**. Proceed to **Phase 1 — Desktop foundation**:

1. Scaffold the Electron + React + TypeScript + Vite + pnpm workspace in `apps/desktop` and `apps/daemon`, preserving the three-panel shell, compact sidebar, bottom composer controls, ChatGPT-like settings, twelve two-eye SVG avatars, and neutral design tokens from `design/tokens.json` and `prototype/`.
2. Implement SQLite migrations (per `docs/DB_SCHEMA.md`), restricted Electron preload IPC (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`), and daemon lifecycle management.
3. Wire the verified `CodexAppServerAdapter` behind the daemon's policy/approval broker (keeping `full-access` disabled by default) alongside an explicit `mock/` adapter for offline UI/Playwright tests.
4. Keep secondary providers (OpenClaw native WS adapter, Ollama, Kimi ACP, Claude, Gemini) gated until their respective live verification checks pass.

Start with [progress](PROGRESS.md), [provider evidence](PROVIDER_MATRIX.md), [ADR 0004](adr/0004-codex-jsonrpc-and-sandbox-containment.md), and [test plan](TEST_PLAN.md).
