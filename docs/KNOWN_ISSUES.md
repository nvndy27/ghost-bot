# Known issues

- Phase 2D still needs end-to-end live recovery evidence. Session inspection reports provider thread access as unknown when only the persisted ID and runtime connection state are known.
- Ollama discovery requires an Ollama service at `127.0.0.1:11434` (currently not installed locally).
- Kimi Code CLI (`kimi`) is not installed locally; live `kimi acp` negotiation is unverified.
- OpenClaw Gateway probe verified `ws://127.0.0.1:18789` reachability with `operator.read` (`read_only`); a native WebSocket adapter with scoped device pairing and execution controls is not yet implemented.
- Codex `full-access` (`dangerFullAccess`) remains disabled by default; only `read-only`, `ask-approval`, and `workspace` (with `excludeSlashTmp: true` and `excludeTmpdirEnvVar: true`) are verified.
- Prototype settings, usage, tools, routines and approvals in `prototype/` remain demonstration data until Phase 1/2 desktop integration.
- The design screenshots under `design/references/` travel separately from Git while distribution rights are unresolved.
