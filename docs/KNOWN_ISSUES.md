# Known issues

## Personal & Friends Alpha release risks (2026-11-27)

- The stacked provider checkpoints contain offline-tested adapters; unified native dispatch and per-provider live acceptance must be verified before advertising supported Chat execution. Live Teams/Autonomous/Computer Use gates must not be loosened merely to meet the alpha schedule.
- Group Bot discussion-first UX, member-scoped model routing, user-visible private task chats and durable summary publishing still require implementation and isolation/cancellation tests.
- Mini IDE/Browser Preview/Output require new workspace-scoped file and Git authorization, conflict handling and browser isolation tests; the existing Scoped Terminal remains non-interactive and Computer Use remains separate.
- Final integrated packaging/platform and data-upgrade acceptance are outstanding; public source distribution additionally requires explicit license selection, asset-rights and secret/history review. These are planning blockers, not newly observed test failures.

## Existing issues

- Fedora RPM packaging via `electron-builder` (`pnpm package:rpm`) is blocked on this host because bundled `fpm` requires `libcrypt.so.1` (`libxcrypt-compat`, not installed) and `fpm` is not on `PATH`; deferred to Phase 2E.
- AppImage native FUSE launch requires `libfuse.so.2`, which is absent on Fedora 45; use `APPIMAGE_EXTRACT_AND_RUN=1` until FUSE2 or RPM distribution is available.
- Ollama CLI and daemon are not installed on this host (`http://127.0.0.1:11434` unreachable, `~/.ollama` absent); `OllamaLocalAdapter`, `RuntimePolicyBroker.authorizeOllamaExecution`, and Electron IPC/UI are verified against deterministic loopback HTTP fixtures, while live local inference requires installing Ollama and pulling a local model.
- LM Studio (`127.0.0.1:1234`), llama.cpp (`127.0.0.1:8080`), and OpenRouter (`https://openrouter.ai/api/v1`) are implemented and offline-verified, but local binaries/servers are absent on host and OpenRouter live API execution remains gated by default.
- Kimi Code CLI (`kimi`) is not installed locally; `KimiAcpAdapter`, `RuntimePolicyBroker.authorizeKimiAcpExecution`, and Electron UI/IPC are verified against pinned ACP v1 protocol fixtures, while live `kimi acp` interoperability remains unverified.
- Google Gemini API (`GoogleGeminiApiAdapter`) is implemented and offline-verified, but live API requests and `/v1beta/models` discovery remain gated by default until explicit user opt-in and API key configuration in OS Secret Service. `gemini` CLI is not installed on this host.
- Anthropic Claude API (`AnthropicClaudeApiAdapter`) is implemented and offline-verified, but live API-billed execution and `/v1/models` discovery remain gated by default until explicit user opt-in and API key configuration in OS Secret Service. Claude.ai subscription token extraction/proxying remains prohibited.
- OpenClaw Gateway probe verified `ws://127.0.0.1:18789` reachability with `operator.read` (`read_only`); a native WebSocket adapter with scoped device pairing and execution controls is not yet implemented.
- Codex `full-access` (`dangerFullAccess`) remains disabled by default; only `read-only`, `ask-approval`, and `workspace` (with `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true`) are verified.
- Prototype settings, usage, tools, routines and approvals in `prototype/` remain demonstration data until Phase 1/2 desktop integration.
- The design screenshots under `design/references/` travel separately from Git while distribution rights are unresolved.
