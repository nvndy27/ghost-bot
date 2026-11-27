# Roadmap

## Accepted release baseline — 2026-11-28

PR #46 merged to main `bae63048978ea0188d784a4d53910f3fb31cd552` on 2026-11-27. Agent 2 independently accepted final head `c08c4a7344b03658f23d9d9a0b61bcbd5b1ea6f0`. Final offline CI and CodeQL passed on that head. Alpha.1 and Alpha.2 are **Verified** within the accepted offline and authorized personal Workspace capability boundaries. Live Teams and additional provider execution require separate acceptance. v0.1 is **not released**. [PR #46 acceptance](https://github.com/nvndy27/ghost-bot/pull/46#issuecomment-7224652321), [CI](https://github.com/nvndy27/ghost-bot/actions/runs/46042628210), [CodeQL](https://github.com/nvndy27/ghost-bot/actions/runs/46042628175).

[Release capabilities, provider plans and release checklist](extensions/alpha3b-release-readiness.md) govern the next handoff. Agent 2 owns Alpha.3A packaging readiness and platform gaps. Alpha.4 UI acceptance requires maintainer scope approval before final candidate freeze and a single final package build and verification cycle.


States are Not Started, In Progress, Implemented, Tested, Verified and Blocked. See [progress](PROGRESS.md) for test evidence.

## Product release track — v0.1 Personal & Friends Alpha

Owner scope decision (2026-11-27): the first daily-use build for the maintainer and a small circle of friends is the existing Chat workspace foundation plus **exactly two new feature areas: Group Bot and the right-hand Workspace Panel**. Local-first, open-source-first direction, BYOK/local AI and supported subscription flows; no Ghost Bot account, payment, paid plan, central server or cloud dependency. The source repository is now public, with MIT OR Apache-2.0 selected for original project code and documentation. Asset-rights, dependency attribution and secret/history reviews remain required; public repository visibility does not imply release readiness.

This release track supplements, not replaces or renumbers, Phases 0–6 and the existing Core/CU/Provider milestones below and in [progress](PROGRESS.md) / [next steps](NEXT_STEPS.md). Existing evidence and gates remain authoritative. Implemented/offline-tested adapters are not proof of live execution. Do not skip the current assigned provider/integration work or declare any new feature complete based on this plan.

### Alpha.0 — Usable native Chat foundation
- **Verified** — Scoped internal personal Codex Chat was accepted on the Alpha.0 baseline merged via PR #15. The dedicated live acceptance verified completion, cancellation and restart recovery. See [progress](PROGRESS.md) for evidence and remaining provider and packaging gates.
- Preserve existing personal bot creation/editing, avatars, individual conversation history, model/effort selection, streaming, usage, Memory, Knowledge, MCP, Skills, Routines, Computer Use and Scoped Terminal in their actually supported capability states. Complete or visibly gate unsupported operations; do not silently remove safety gates or promise unsupported provider tools.
- Perform bounded live acceptance only with explicit authorization and valid official provider flows. A first usable personal Chat build may ship internally once this gate and its packaging smoke checks pass; the full v0.1 milestone also requires Alpha.1–3.
- Gate: at least one verified live provider path remains functional; each advertised live provider/capability has matching evidence; unsupported paths fail closed with clear status; no unauthorized inference or billing.

### Alpha.1 — Group Bot & private task collaboration
- **Verified** — Alpha.1 integrity, organization, routing, offline discussion, private delegation, summaries and avatars were accepted through PR #46. Final release UI acceptance belongs to the proposed Alpha.4 scope.
- **Tested** — [Alpha.1B membership and routing](extensions/alpha1b-group-membership-model-routing-contract.md) supports scoped overrides and immutable offline routing. Other provider catalogs and live Teams remain gated.
- **Tested** — Alpha.1A adds durable bot and group pinning, ordering and search, provider-only labels alongside existing avatars and names, personal conversation management and durable personal unread indicators. See [Alpha.1A evidence](extensions/alpha1a-bot-conversation-management.md). Offline Group tasks and Private Task Chats are accepted through PR #46. Live execution stays gated.
- Group creation/editing: add/remove existing bots; default new groups 2–6 members, existing supported advanced cap 12, preserve legacy groups without destructive migration. Default concurrency 2 and automatic discussion 1–2 rounds; enforce daemon-side bounds and user-configurable token/time budgets within validated limits.
- Group is discussion-first: user/bot messages, `@bot` and `@all`, independent answers and bounded replies/reflection. No direct filesystem edits, command execution, browser actions or other side-effecting tools in group discussion. Keep Chief of Staff/DAG/ledger functionality as a bounded advanced task/activity surface; do not remove established security controls.
- Each member inherits its own provider/account/model/effort/personality by default. Click member to select a discovered, authorized model; distinguish explicit team-scoped overrides from global bot changes. Validate effective configuration at dispatch, snapshot it per run, and create compatible sessions when changing provider; never mutate an active run or silently substitute a model.
- Delegation: user-approved or explicitly pre-authorized work creates a dedicated, user-visible Private Task Chat under the assigned bot, linked to the group/task/run. Work happens there (files, tools, build/test, approvals); never inject task work into an unrelated personal thread. Independent tasks may run in parallel within bounds.
- Automatically publish a bounded status/summary/result back to the originating group, with artifacts/evidence/blockers and a link to the task conversation. Report actual success/failure/cancel/uncertain state, not inferred success; durable idempotent publishing, no raw secrets/log dump or private memory disclosure. Group remains usable while tasks run.
- Gate: real group UI and daemon persistence survive restart; per-bot runtime/model routing is correct; member removal/revocation/cancellation and duplicate delivery are tested; discussion cannot invoke privileged tools; private context stays isolated; at least a bounded, explicitly authorized multi-provider group/task workflow is verified before advertising live multi-model collaboration. Existing live Teams gates remain until separately verified and approved.

### Alpha.2 — Right-hand Workspace Panel (Mini IDE & Live Demo)
- **Verified** — Read-only Git Changes is accepted through PR #46 within native-grant and sandbox boundaries.
- **Verified** — Accepted shell retains the three-panel Chat shell, light/dark/system theme and resizable/collapsible sidebars. Existing Bot Workspace / Team Activity becomes the default Overview tab; keep Live Computer, Active Tasks, Routines, Connected Tools and Account Usage. New tabs are Files/Editor, Changes, Browser and Output. Reuse the panel later in Terminal Mode.
- **Verified** — Accepted Alpha.2A/B integration provides daemon-authorized personal workspace list and read over Electron IPC, with persisted tab selection and Team Activity in Group Chat.
- **Verified** — Alpha.2C.2 supports native-granted personal text save and empty file/folder creation within the accepted PR #46 boundaries.
- **Blocked** — Non-empty create, rename, quarantine delete, Ask Approval writes and group writes await safe publication or dedicated authorization.
- **Verified** — Alpha.2C.1 search, preview, cancellation and explicit personal conversation draft insertion are integrated and offline accepted through PR #46.
- **Verified** — Alpha.2D.1 native-granted, read-only Git Changes is accepted through PR #46.
- **Blocked** — Alpha.2D.2 stage, unstage and single-file revert await enforceable protection of the real index and working tree. The Changes tab exposes the gate and supports read-only refresh.
- Files/Editor: authorized workspace tree, open multiple files in tabs, syntax highlighting, edit/save, create/rename/delete with appropriate confirmation, file and content search, file-change watching, explicit send-selection-to-chat, preview Markdown/images/SVG/PDF. Handle unsaved/external-change conflicts; root/symlink/path traversal protections, bounded file sizes, binary/secret handling and no privileged renderer filesystem access.
- Changes: current branch, Git status, modified files, before/after diffs, stage/unstage, confirmed revert and basic commit history. Bind to selected bot/task authorized workspace; no implicit destructive Git operations. Show actual evidence, not fabricated changes.
- Browser/Live Demo: embedded user-controlled website and localhost preview, URL bar, back/forward/reload, tabs, dev-server HMR when available, desktop/mobile viewport, screenshot, console/DevTools. Separate from the existing isolated Computer Use worker and its approvals; isolate untrusted web content, deny privileged IPC/Node access, restrict navigation/protocols/popups/downloads and manage view lifecycle. No agent-controlled browser or DOM-to-agent automation in this milestone.
- Output: actual provider/tool/run log, command/build/test/exit state when emitted, clickable authorized paths/preview URLs, cancel when supported. Clearly label unavailable output. This is not an interactive PTY; preserve Scoped Terminal restrictions.
- Candidate libraries (not mandatory until justified against current lockfile/architecture): Monaco Editor, Chokidar, Git CLI, Ripgrep, Electron WebContentsView, optional Dockview, PDF.js and safe Markdown renderer. Avoid unnecessary dependencies; verify licenses, packaging and security.
- Gate: actual file/diff/live-preview/output vertical slices through validated IPC, workspace isolation and write-conflict tests, browser isolation and loopback fixture tests, no regression in existing Overview/Team/Computer Use/approval behavior, no fake production data, responsive panel layout and keyboard access.

- **Verified** — Alpha.2G integrates all five Workspace tabs with native grant and restart coverage on accepted main. See [convergence and package acceptance](extensions/alpha2g-workspace-convergence.md). Hosted CI and independent acceptance passed for the merged PR #46 head.

### Alpha.3 — Personal & Friends Alpha release acceptance
- **Tested** — PR #47 corrects the save Electron wait to require acknowledged completion. The exact empty-content CI failure was reproduced with a paused daemon. Corrected focused save/watch/conflict/revocation acceptance passed using an existing artifact. Complete-suite verification is delegated to hosted CI.
- **In Progress** — Alpha.3A packaging readiness on merged baseline `bae63048978ea0188d784a4d53910f3fb31cd552`. Integration is accepted within scope. Stabilize package CSP readiness and prepare final Fedora/Ubuntu installation, FUSE and upgrade checks after UI refinement. See [Alpha.3A packaging readiness](extensions/alpha3a-packaging-readiness.md).
- **In Progress** — Alpha.3A packaging readiness belongs to Agent 2. Alpha.3B documents release capabilities and bounded provider acceptance plans. Hosted unified acceptance passed. Final release artifacts require their own frozen-source evidence.
- **Verified** — Alpha.0–2 are integrated on the accepted baseline. Existing migrations `0001–0014` are preserved; any schema change must use a coordinated forward migration, tested fresh/upgrade/restart/rollback. Do not bypass the existing policy broker, authenticated daemon, sandbox, approvals, or provider-specific gates.
- Follow the parallel development policy in AGENTS.md. Coordinate reconciliation and migrations while preserving separate worktrees and maintainer merge authority.
- Gate: lint, typecheck, build, regression and real Electron E2E evidence, secrets/permissions review, data preservation, independent acceptance; install/launch/update/restart checks on Fedora GNOME and Ubuntu where available, Windows only when actually supported/tested (not a required first-alpha release platform). Verify packages and document supported platforms and known limitations. Prepare simple installation/usage instructions; no public repository visibility or license change as part of this roadmap decision.
- **Release boundary:** v0.1 Personal & Friends Alpha is ready only when Alpha.0–3 pass for the documented supported scope. No Terminal Workspace, full interactive PTY, advanced AI browser automation, Companion, billing or remote/cloud services are required. Use existing versioning convention; alpha tags/numbering to be coordinated at release.

### Alpha.4 — Approved V03.2 UI implementation

- **In Progress** — The maintainer approved V03.2 design and assigned shared shell/Chat/Settings/Usage to Alpha.4A and Workspace UI to Agent 2 Alpha.4B. See [shared UI contract](extensions/alpha4-shared-ui-contract.md). Implementation proceeds on provisional Alpha.3C while required review and CI gate merging.
- Production visual acceptance, two-agent reconciliation, final candidate freeze and the final Agent 2 package build/verification remain open.

### Post-alpha roadmap (deferred, not current assignments)
- **Not Started** — v0.2 Dual-Mode Workspace: Chat / Terminal switch in upper-left of both layouts; Orca-style project/worktree sidebar, interactive user PTY, CLI registry (including supported agy/Codex/Claude flows), tabs and nested splits, reconnect, usage from official sources. Reuse Alpha.2 workspace tools; retain existing scoped sandbox separately.
- **Not Started** — v0.3 Advanced collaboration: Ghost Council, Bridge, Verify and shared project memory, evidence-driven cross-provider handoff and verification.
- **Not Started** — v0.4+ Companion and optimization: Dots-inspired event-driven goals, explicit consent/budgets and background lifecycle; advanced routing, remote workspace, cloud computer, mobile and marketplace only after community demand and separate design/security acceptance. Commercial plans are deferred until meaningful adoption; no paywalls in the first alpha.

## Phase 0 — Technical proof

- **Verified** — Starter kit audit, project rename, Git initialization and initial private GitHub push.
- **Verified** — Reusable JSON-RPC stdio client (`packages/runtime-adapters/json-rpc-client.ts`) and Codex App Server adapter (`packages/runtime-adapters/codex/codex-app-server.ts`).
- **Verified** — Dedicated ChatGPT-authenticated Codex profile (`plus`), model/effort discovery, live rate-limit windows, streaming, cancellation, session resume, read-only/workspace sandboxing (`excludeSlashTmp: true`), and rejected approval with no side effect.
- **Verified** — OpenClaw CLI health and read-only loopback gateway probe (`operator.read`).
- **Tested** — 16 offline unit tests (JSON-RPC correlation, concurrency, timeouts, cancellation, crashes, malformed payloads, unknown quota, permission modes, approval rejection) and strict TypeScript check.
- **Blocked** — Live Ollama discovery (no local service) and live Kimi ACP (CLI not installed); non-blocking for Phase 1.
- **Verified** — Phase 0 exit gate **PASS** (2026-11-25). Ready for Phase 1 desktop foundation.

## Phase 1 — Desktop foundation
- [x] Electron + React TS + Vite + pnpm workspace, lint/typecheck/test pipeline (Phase 1A **Verified**).
- [x] Secure IPC, daemon lifecycle, mock adapter, and SQLite migrations (Phase 1A/1C **Verified**).
- [x] Three-panel shell, 13-section Settings, theming, resized/collapsed panels, keyboard accessibility (Phase 1B/1D **Verified**).
- [x] Bot CRUD, SVG avatar editor, SQLite persistence, and custom SVG sanitization (Phase 1C **Verified**).
- [x] Daemon runtime registry, policy broker, and Codex metadata/usage/model bridge (Phase 1D **Verified**).
Gate: restart persistence, UI matches references, offline integration tests pass — **Phase 1 Gate PASS**.

## Phase 2 — Functional MVP
- [x] Phase 2A — Daemon-owned session, run, event, and message persistence foundation (**Verified**; merged to `main` at `2ffc521`).
- [x] Phase 2B — Live read-only Codex execution, thread continuity, streaming, and cancellation (**Verified**; 3-turn live Electron+Codex E2E and offline suites passed).
- [x] Phase 2C — Live tools, durable interactive approvals, and workspace-write permissions (**Verified**; live Deny + Approve once + canary containment + 53/53 tests passed).
- [x] Phase 2D — Runtime recovery, reconnect, thread inspection, manual retry, and Linux AppImage packaging (**Verified**; 2-turn live recovery, security hardening, and packaged AppImage 2-launch verification passed; RPM packaging deferred to Phase 2E).
- [x] Real verified Codex integration; connect/disconnect/stream/cancel/resume.
- [x] OpenClaw adapter if verified; optional local Ollama (**Metadata Verified / Execution Gated** for OpenClaw `2026.11.8`; `OllamaLocalAdapter` optional/protocol-tested and unavailable on host).
- [x] Dynamic model/effort, actual permission enforcement, approval/diff display.
- [x] Usage source and timestamps; unknown quotas shown correctly; opt-in API costs.
- [x] Fedora packaging and security tests (AppImage **Verified** via `APPIMAGE_EXTRACT_AND_RUN=1`; native `rpmbuild` RPM built, inspected, and extracted-package smoke-verified).
Gate: one verified subscription path, real streaming, denial yields no side effect, restart recovery — **Phase 2 Gate PASS** (see `docs/PHASE2_RELEASE_REPORT.md`).

## Phase 3 — Agent core
- **Verified** (Phase 3D.0 Integration Foundation) — Merged Track B independent packages (`@ghost-bot/memory`, `@ghost-bot/knowledge`, `@ghost-bot/mcp`) onto `main` (`07839ff`), upgraded all workspaces to `zod@4.6.7` (`GHSA-mrhx-c7xc-m3w5` resolved, `0` prod vulnerabilities), and passed `typecheck`, `lint`, `build`, `verify-phase-2e-acceptance.mjs`, and 3 consecutive `102/102` test runs (see [Phase 3D.0 report](extensions/phase-3d0-integration-report.md)).
- **Verified** (Phase 3D.1 Production Memory Integration) — Added migration `0005_memory_core`, daemon-owned `MemoryService` (`createBorrowedMemoryDatabaseHandle`), trusted server-side `MemoryAuthContext`, strict Zod v4 memory IPC, `MemorySettingsSection` UI, and dispatch-boundary `RunOrchestrator` context assembly + revalidation (see [Phase 3D.1 report](extensions/phase-3d1-memory-integration.md)).
- **Verified** (Phase 3D.2 Production Knowledge & Retrieval Integration) — Added migration `0006_knowledge_core`, daemon-owned `KnowledgeService` (`createBorrowedKnowledgeDatabaseHandle`), trusted file-grant ingestion (`.txt`/`.md`), revision-aware citations, `KnowledgeSettingsSection` UI, and combined Memory+Knowledge dispatch-boundary context assembly (`<= 12288` bytes) (see [Phase 3D.2 report](extensions/phase-3d2-knowledge-integration.md)).
- **Verified** (Phase 3D.3 Production MCP Integration) — Added migration `0007_mcp_core`, daemon-owned `McpService` (`createBorrowedMcpDatabaseHandle`), `RuntimePolicyBroker.createMcpPolicyAdapter`, durable `approvals` + `mcp_approval_bindings` single-use execution, `McpSettingsSection` UI, and real local STDIO fixture tool/resource/prompt verification (see [Phase 3D.3 report](extensions/phase-3d3-mcp-integration.md)).
- **Verified (Offline RC)** (Phase 3D.4 Integrated End-to-End Acceptance) — Verified unified v4/v5/v6->v7 upgrades, combined 27-step Memory+Knowledge+MCP Electron E2E, ~2500-chunk cross-extension responsiveness, and rebuilt AppImage + Fedora RPM packaging; OS Secret Service keyring for MCP `secretRefs` and native Codex MCP (`unsupported_native_mcp`) remain open for follow-up (see [Phase 3D.4 report](extensions/phase-3d4-integrated-acceptance.md)).
- **Tested** (Provider.7 Unified Multi-Provider Execution) — Resolved `LIVE_INFERENCE_DISABLED` 501 execution gap in `RunOrchestrator`, `RuntimeRegistry`, and `DaemonServer` across `openclaw`, `ollama`, `claude-api`, `gemini-api`, `kimi-acp`, `lmstudio`, `llamacpp`, and `openrouter` while preserving Codex and fail-closed `RuntimePolicyBroker` gating (see [Provider.7 report](extensions/provider7-unified-execution.md)).
- **Tested** (Alpha.0A Native Chat Closure & Integration Readiness) — Closed A0-01..A0-06 native Chat consistency, atomic preflight/dispatch barriers, structured canonical history role separation, provider daemon-path coverage, and loopback proxy/sandbox checks (see [Alpha.0A report](extensions/alpha0a-native-chat-closure.md)).
- [ ] OS Secret Service keyring for MCP `secretRefs`, native Codex MCP (`dynamicToolCall`), skills, terminal/artifacts, and audit.
- [ ] Add other supported runtime/provider adapters according to verified matrix.
Gate: no cross-agent leaks; tool and memory consent validated.

## Phase 4 — Multi-agent teams
- [ ] Chief of Staff, team/group chat, task delegation, parallel execution, task ledger.
- [ ] Bound depth, attempts, tokens/time and concurrency; aggregate usage and stop propagation.
Gate: delegation failures, cancellation and budget exhaustion tested.

## Phase 5 — Autonomous work
- [ ] Durable scheduler, timezone, cron, webhook/file triggers, retry, missed-run policy, notifications.
- [ ] systemd user service opt-in, browser sandbox and live virtual desktop, logs.
Gate: restart/idempotency/approval handling and isolated browser tested.

## Phase 6 — Expansion
- [ ] Consented meeting assistant, mobile companion, remote gateway, marketplace, Windows/macOS.
Gate: threat model, consent, privacy and platform-specific tests reviewed.
