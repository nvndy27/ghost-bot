# Known issues

- Fedora RPM packaging via `electron-builder` (`pnpm package:rpm`) is blocked on this host because bundled `fpm` requires `libcrypt.so.1` (`libxcrypt-compat`, not installed) and `fpm` is not on `PATH`; deferred to Phase 2E.
- AppImage native FUSE launch requires `libfuse.so.2`, which is absent on Fedora 45; use `APPIMAGE_EXTRACT_AND_RUN=1` until FUSE2 or RPM distribution is available.
- Ollama CLI and daemon are not installed on this host (`http://127.0.0.1:11434` unreachable, `~/.ollama` absent); `OllamaLocalAdapter`, `RuntimePolicyBroker.authorizeOllamaExecution`, and Electron IPC/UI are verified against deterministic loopback HTTP fixtures, while live local inference requires installing Ollama and pulling a local model.
- Kimi Code CLI (`kimi`) is not installed locally; live `kimi acp` negotiation is unverified.
- OpenClaw Gateway probe verified `ws://127.0.0.1:18789` reachability with `operator.read` (`read_only`); a native WebSocket adapter with scoped device pairing and execution controls is not yet implemented.
- Codex `full-access` (`dangerFullAccess`) remains disabled by default; only `read-only`, `ask-approval`, and `workspace` (with `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true`) are verified.
- Prototype settings, usage, tools, routines and approvals in `prototype/` remain demonstration data until Phase 1/2 desktop integration.
- The design screenshots under `design/references/` travel separately from Git while distribution rights are unresolved.
