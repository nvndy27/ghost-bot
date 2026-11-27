## Licensing and public source distribution

## Alpha.1B routing limits

- Routing catalogs expose the offline mock catalog or the active verified Codex subscription catalog. Other provider/account catalogs remain unavailable for team routing. Live Teams remains gated. The Codex catalog path has no live acceptance evidence.

- Original project code and documentation are offered under MIT OR Apache-2.0, subject to copyright holders' authority. This does not license third-party dependencies, screenshots, or trademarks. The tracked files under `design/references/` require separate rights review and must not be redistributed without permission. Review dependency notices and packaged attributions, contributor rights, and Git history for secrets before public binary distribution. No full provenance or security audit was performed by the licensing change.

## Personal & Friends Alpha release risks (2026-11-27)

- Alpha.0 is accepted for scoped internal Codex Chat through PR #15. Public distribution remains blocked by CU4-PKG-02. Live Teams, autonomous Scheduler, Computer Use, and the remaining provider gates stay in force.
- The Alpha.2A/B candidate exposes personal workspace list and read after native directory confirmation. Read grants expire when the daemon stops or the bot authorization changes. Group filesystem access requires an authorized task scope.
- The PR #39 checkpoint allows native-granted personal Workspace mode to save text and create empty files/folders on Linux. Save performs bounded verification after atomic replacement. External processes can race POSIX namespace operations. Non-empty creation needs descriptor-bound publication and cleanup. Rename and delete need source identity guarantees, and delete also needs safe quarantine creation and recovery. Existing quarantine entries stay recoverable. Ask Approval and group writes remain gated.
- Alpha.2D.2 Git writes are unavailable. Snapshot inspection is read-only. Real index publication needs to preserve external index and lock changes and validate the approved revision at publication. Reverting a working-tree file also needs a safe expected-revision replacement.
- Hosted Noble passed Workspace and failed Computer Use at Chrome's SUID helper on PR #45 through `c174875`. The replacement CI uses Jammy and pinned Bubblewrap 0.13.1. Exact-head hosted acceptance remains pending. [Previous hosted failure](https://github.com/nvndy27/ghost-bot/actions/runs/45998660975/job/140504401185)
- The unified candidate adds an explicit Private Task Chat guard for right-panel and draft routing. Personal Output filters private runs at the daemon boundary. Agent 2's integrated verdict remains pending.
- Alpha.2G Workspace package acceptance is scoped to Fedora desktop fixtures and the offline mock runtime. Installed RPM launcher, AppImage FUSE path, Ubuntu desktop packaging, public browser networking and live runtime checks require separate evidence.
- Unified acceptance requires independent review, maintainer visual approval and required CI on the actual candidate. Agent 2 owns any follow-up on the hosted isolation check.
- Group integrity PR #42 prevents new split private bindings and fails closed on legacy orphan metadata. Its corrected restart fixture exercises authorized private delegation. The correction also covers a concurrent operation-ID collision across assignees.
- Final Personal & Friends Alpha platform and live acceptance gates are open.

## Alpha.1A limits

- Durable unread and completion indicators cover personal conversation activity. Group task indicators require the Alpha.1D task and conversation contract.

## Shared baseline review

- Independent review of PR #20 and the convergence candidate remains pending. The read-only Git proposal is independent of the filesystem write gate and still requires maintainer approval.
- Alpha.2C.1 search, preview and chat draft insertion require Agent 1 shared IPC and composer integration. PDF previews require compatible host Poppler, prlimit and Bubblewrap with isolated user and network namespaces. Preview is unavailable when those capabilities cannot be established.

## Alpha.2C.1 integration

- The shared discovery candidate is provisionally stacked on PR #21. Daemon IPC is tested. Agent 2 owns combined Electron acceptance, including PDF and selection-to-draft. Save, group filesystem access and Git mutation gates are unchanged.

- Read-only Git Changes requires an isolated Linux runtime and an ordinary local repository at the granted root. Linked, redirected and oversized repositories fail closed. Packaging support awaits Alpha.3 verification.

## Alpha.1 convergence

- Issue #41 awaits independent acceptance and history-preserving convergence with Agent 2’s workspace stack. The successor introduces no database migration. Advance neither workspace permissions nor Alpha.3 acceptance during reconciliation.

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

## Open-source automation acceptance

CI, CodeQL, Scorecard, Dependabot and dependency-graph SBOM export are configured; first successful runs and repository settings are pending verification. OpenSSF Best Practices and REUSE compliance have not been achieved. A graph SBOM is not a complete packaged-binary SBOM or legal attribution inventory.
