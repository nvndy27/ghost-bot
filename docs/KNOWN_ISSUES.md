## Personal & Friends Alpha release risks (2026-11-27)

- Alpha.0 is accepted for scoped internal Codex Chat through PR #15. Public distribution remains blocked by CU4-PKG-02. Live Teams, autonomous Scheduler, Computer Use, and the remaining provider gates stay in force.
- The Alpha.2A/B candidate exposes personal workspace list and read after native directory confirmation. Read grants expire when the daemon stops or the bot authorization changes. Group filesystem access requires an authorized task scope.
- Workspace file containment requires Linux with `/proc/self/fd` and fails closed without it. Save is blocked at the daemon boundary. Staged-file identity and revision checks cannot make POSIX rename conditional on an unchanged target and source entry when another process writes concurrently. Ask Approval also requires an explicit grant before the write path can be exposed.
- Final Personal & Friends Alpha integrated packaging, platform, and remaining live acceptance gates are open.

## Alpha.1A limits

- Durable unread and completion indicators cover personal conversation activity. Group task indicators require the Alpha.1D task and conversation contract.

## Shared baseline review

- Independent review of PR #20 and the convergence candidate remains pending. The read-only Git proposal is independent of the filesystem write gate and still requires maintainer approval.

## Existing issues

- Fedora RPM packaging via `electron-builder` (`pnpm package:rpm`) is blocked on this host because bundled `fpm` requires `libcrypt.so.1` (`libxcrypt-compat`, not installed) and `fpm` is not on `PATH`; deferred to Phase 2E.
- AppImage native FUSE launch requires `libfuse.so.2`, which is absent on Fedora 45; use `APPIMAGE_EXTRACT_AND_RUN=1` until FUSE2 or RPM distribution is available.
- Ollama CLI and daemon are not installed on this host (`http://127.0.0.1:11434` unreachable, `~/.ollama` absent); `OllamaLocalAdapter`, `RuntimePolicyBroker.authorizeOllamaExecution`, and Electron IPC/UI are verified against deterministic loopback HTTP fixtures, while live local inference requires installing Ollama and pulling a local model.
- LM Studio (`127.0.0.1:1234`), llama.cpp (`127.0.0.1:8080`), and OpenRouter (`https://openrouter.ai/api/v1`) are unified-execution verified against loopback HTTP / synthetic transport and Electron E2E, but local binaries/servers are absent on host and OpenRouter live API execution remains gated by default.
- Kimi Code CLI (`kimi`) is not installed locally; `KimiAcpAdapter`, `RuntimePolicyBroker.authorizeKimiAcpExecution`, and Electron UI/IPC are verified against pinned ACP v1 protocol fixtures, while live `kimi acp` interoperability remains unverified.
- Google Gemini API (`GoogleGeminiApiAdapter`) is implemented and offline-verified, but live API requests and `/v1beta/models` discovery remain gated by default until explicit user opt-in and API key configuration in OS Secret Service. `gemini` CLI is not installed on this host.
- Anthropic Claude API (`AnthropicClaudeApiAdapter`) is implemented and offline-verified, but live API-billed execution and `/v1/models` discovery remain gated by default until explicit user opt-in and API key configuration in OS Secret Service. Claude.ai subscription token extraction/proxying remains prohibited.
- OpenClaw Gateway probe verified `ws://127.0.0.1:18789` reachability with `operator.read` (`read_only`); a native WebSocket adapter with scoped device pairing and execution controls is not yet implemented.
- Codex `full-access` (`dangerFullAccess`) remains disabled by default; only `read-only`, `ask-approval`, and `workspace` (with `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true`) are verified.
- Prototype settings, usage, tools, routines and approvals in `prototype/` remain demonstration data until Phase 1/2 desktop integration.
- The design screenshots under `design/references/` travel separately from Git while distribution rights are unresolved.
