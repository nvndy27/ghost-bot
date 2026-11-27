# Next steps

## Alpha.4 integration handoff

Alpha.3C PR #49 remains provisional until maintainer merge approval. Agent 2 accepted exact head `5a8c69d`, and required hosted CI passed. Alpha.4A PR #50 proceeds independently from that checkpoint. Agent 2 consumes the shared V03.2 contract and owns Workspace-specific UI. Reconcile the two feature histories before integrated visual acceptance. Final packages follow UI approval and candidate freeze.


## Alpha.3C unified checkpoint

**Implemented** — Provisional convergence of Alpha.3A PR #47 at `f6716739e5ba9897c9a77e4fd3d0a2096a436202` and Alpha.3B PR #48 at `140b591dfe79dec3760365ea36c965e608f2cc24` on accepted main `bae63048978ea0188d784a4d53910f3fb31cd552`. Both histories, the CSP attachment and acknowledged-save timing corrections, and all nine provider plans are preserved. Reconciliation changes documentation only. Existing tests are reused. Required CI and Agent 2 focused acceptance gate merging.

The maintainer has now approved V03.2 for Alpha.4 implementation. Agent 1 proceeds with shared and Chat UI on this provisional checkpoint while Agent 2 owns Workspace UI independently. Final candidate freeze and Agent 2 package verification follow UI acceptance. v0.1 remains unreleased.


## Accepted release baseline — 2026-11-28

PR #46 merged to main `bae63048978ea0188d784a4d53910f3fb31cd552` on 2026-11-27. Agent 2 independently accepted final head `c08c4a7344b03658f23d9d9a0b61bcbd5b1ea6f0`. Final offline CI and CodeQL passed on that head. Alpha.1 and Alpha.2 are **Verified** within the accepted offline and authorized personal Workspace capability boundaries. Live Teams and additional provider execution require separate acceptance. v0.1 is **not released**. [PR #46 acceptance](https://github.com/nvndy27/ghost-bot/pull/46#issuecomment-7224652321), [CI](https://github.com/nvndy27/ghost-bot/actions/runs/46042628210), [CodeQL](https://github.com/nvndy27/ghost-bot/actions/runs/46042628175).

[Release capabilities, provider plans and release checklist](extensions/alpha3b-release-readiness.md) govern the next handoff. Agent 2 owns Alpha.3A packaging readiness and platform gaps. Alpha.4 UI acceptance requires maintainer scope approval before final candidate freeze and a single final package build and verification cycle.

## Release sequence

1. Complete Alpha.3 readiness using Agent 2's Alpha.3A dependency and platform assessment and the Alpha.3B capability and provider plans.
2. Obtain maintainer approval of Alpha.4 UI acceptance scope, then record its actual verdict.
3. Freeze one final release candidate SHA and its supported platforms, capabilities and limitations.
4. Agent 2 builds and verifies the final packages once from that SHA, recording checksums, dependencies, artifact-specific results and remaining platform gaps.
5. The maintainer approves the release and distribution audience after reviewing the checklist. v0.1 remains unreleased until that decision.

Provider plans are proposals for later authorization. Additional live requests, credentials, runtime installation and model downloads require separate authorization. Unavailable optional providers remain visibly unavailable.

## Public binary distribution

Complete the applicable rights, dependency notices, artifact SBOM, secret/history review and signing/provenance requirements tracked in [open-source readiness](OPEN_SOURCE_READINESS.md). Resolve or explicitly limit the advertised platform scope using Agent 2's packaging evidence and Issue #3. Internal alpha readiness and public binary distribution have distinct approval gates.

## Archived milestone handoffs

The following entries preserve the plans and handoffs that preceded PR #46. Pending-review and integration instructions below describe their historical checkpoints. The accepted release baseline and current release sequence above supersede them. Use the new bounded provider plan for future acceptance.

## Unified Alpha.1 and Alpha.2 acceptance

Review the exact unified Draft PR head and its integrated offline evidence. Agent 2 owns the focused independent verdict and the hosted Chromium sandbox prerequisite. The maintainer owns visual approval of the Group composer and Workspace tabs. Required CI must pass on the reviewed head. Keep the executable packaging harness for fresh Alpha.3 artifacts after scope is agreed.

## Alpha.1 integrity and Group Chat polish

Review the integrity and UI stack as part of the unified candidate. Alpha.3 acceptance awaits agreed scope.

## Alpha.1B and Alpha.1C

Review the Alpha.1B draft against accepted main. Keep the approved Alpha.1C discussion feature on a separate branch with mock-only, tool-free execution; preserve advanced Teams runs as separate functionality.

## Alpha.3 combined acceptance

Review daemon shutdown ownership, the explicit Private Task Chat context and personal Output isolation on the combined SHA. Confirm that hosted Ubuntu passes both isolation preflights and required tests. Use the existing Alpha.3 package harness on freshly built artifacts when package acceptance is authorized.

## Alpha.2G to Alpha.3 handoff

Use the [executable package acceptance harness](extensions/alpha2g-workspace-convergence.md#executable-alpha3-packaging-acceptance) for fresh Ubuntu desktop and installed Fedora artifacts. Preserve the current mutation gates and use the unified SHA for fresh package evidence.

## Alpha.2D.2 Git mutation handoff

Reconcile the provisional stack before acceptance. Keep Git write admission denied until a separate native per-operation approval can be bound to the repository, selected paths and expected revisions, and used with a commit mechanism that preserves external writes. Verify race, revocation and partial-publication behavior in real repositories and Electron before enabling any action. Agent 1 can resolve the exact-SHA Private Task Chat findings independently.

## Alpha.2C.2 write handoff

Review the hardened PR #39 head on the provisional stack. Preserve the same-grant admission checks and the new Electron watch and revocation regressions during reconciliation. Keep the gated operations disabled until their publication or authorization boundaries are enforceable.

## Open-source readiness follow-up

- Review and merge the scoped readiness PR; confirm licensing authority for existing contributions and coordinate active Alpha branches.
- Inspect CI, CodeQL, Scorecard and SBOM results; enable dependency graph, Dependabot alerts and private vulnerability reporting as appropriate.
- Register OpenSSF Best Practices with actual evidence; complete per-file rights/REUSE inventory, reference asset and secret/history review, artifact SBOM and signing/provenance before public binary release. See [readiness](OPEN_SOURCE_READINESS.md).

## Licensing follow-up (2026-11-27)

- Review the Apache-2.0 license and attribution change through a scoped PR. Coordinate merging with the active Alpha integration branches. Verify GitHub license detection on the default branch after merge.
- Before public binary distribution, complete dependency/asset-rights and secret/history review; confirm contributor licensing authority and required third-party notices. Existing Alpha assignments and acceptance gates are unchanged.

## Shared baseline maintainer review

Review the [convergence candidate and Alpha.2C proposal](extensions/alpha-shared-convergence.md) and the [Alpha.1B contract](extensions/alpha1b-group-membership-model-routing-contract.md). The maintainer approved Alpha.1B and read-only Git inspection. The shared baseline awaits Agent 2 acceptance of the reconciliation and passing required checks. The read-only Git proposal can be reviewed while write authorization and race protections remain open.

## Alpha.1A — Draft review

Review the Alpha.1A branch against accepted UI.1 main. Shared wiring is available in the separate convergence draft for maintainer review. Keep Group task indicators and Private Task Chats scoped to Alpha.1D.

## Alpha.2D.1 — Read-only Git Changes

Review the isolated draft stacked on PR #22. At convergence, preserve both the existing discovery contract and the feature-specific `inspectWorkspaceGit` / `cancelWorkspaceGit` channels. Re-run the focused Electron Git scenario on the combined baseline. Keep Git mutations gated.

## Alpha.2A–B — Shared Workspace Integration (Draft Review)

1. Review the history-preserving integration candidate on `integration/alpha2ab-shared-wiring`. Coordinate disposition of draft PRs #16 and #18 with their owner.
2. Agent 2 reviews the read contract and the focused Electron acceptance. A native directory confirmation grants daemon-lifetime read access for the persisted personal bot root identity. List/read validate both workspace ID and the grant’s authorization generation. Updating or restoring a workspace or changing its permission requires fresh confirmation. Group access requires an explicit authorized task scope. The saved tab is a UI preference.
3. Keep save disabled until the write boundary can prevent external revision and staged-entry races and can enforce the intended approval and task scope. Define the artifact reference contract when authorized task scope is available.
4. The approved read-only Alpha.2C Git scope awaits the accepted shared main SHA. Its scope is separate from the write boundary above.
5. Alpha.2C.1 has a separate authorized integration branch. Agent 1 reviews the search, preview, cancellation and composer interface handoff and wires shared boundaries. Wire the isolated PDF page renderer through the same guarded preview route. Validate actual Electron search, cancellation, previews and draft insertion on the refreshed convergence baseline before Alpha.2C.1 acceptance.

## Alpha.0B — Integrated Native Chat Release Candidate (Historical Handoff)

Alpha.0 accepted for scoped internal personal Codex Chat in PR #15. The steps below record the original handoff.

1. Agent 2 performs independent security review and Fedora GNOME / Ubuntu AppImage + RPM packaging smoke verification on `integration/alpha0-native-chat-rc`.
2. Owner reviews and authorizes the bounded live acceptance procedure (`<= 3` prompts on Codex CLI `0.172.0` ChatGPT `plus` profile; optional bounded second-provider check) in `docs/extensions/alpha0b-integrated-native-chat-rc.md`.
3. Upon Alpha.0 sign-off, converge PRs #6–#14, #12, and Alpha.0B RC, then allocate single-owner boundaries (`packages/shared-types/ipc.ts`, `apps/desktop/src/App.tsx`, `0014+` migrations) before starting parallel Alpha.1 (Group Bot) and Alpha.2 (Workspace Panel).

## Alpha.0A — Native Chat Closure & Integration Readiness (Completed Offline)

1. Converge stacked PRs #6–#13, documentation PR #12 (`docs/v0.1-personal-friends-alpha`), and Alpha.0A PR per `docs/extensions/alpha0a-native-chat-closure.md`.
2. Complete Agent 2 platform/packaging verification and bounded live acceptance (only when explicitly authorized) to close Alpha.0.
3. Once Alpha.0 is accepted, allocate shared `0014+` migration, `packages/shared-types/ipc.ts`, and `apps/desktop/src/App.tsx` ownership before starting parallel Alpha.1 (Group Bot) and Alpha.2 (Workspace Panel) tracks.

## Provider.7 — Unified Multi-Provider Execution Integration (Completed Offline / Live Spend Gated)

1. Proceed to **Agent 2 Cross-Provider Security Audit & Main Integration** (or Phase 6 Packaging/Release Candidate sign-off) once stacked PRs #6–#12 are reviewed.
2. When explicitly authorized, run bounded live inference checks against installed local runtimes (Ollama / LM Studio / llama.cpp / Kimi CLI) or explicit opt-in cloud API keys per `docs/extensions/provider7-unified-execution.md`.

## Provider.6 — Shared OpenAI-Compatible Runtime Integration (Completed Offline / Execution Gated)

1. When explicitly authorized, test live loopback inference against LM Studio or `llama-server` or bounded 2-request live OpenRouter verification per `docs/extensions/provider6-openai-compatible.md`.
2. Proceed to **Agent 2 Cross-Provider Security Audit & Main Integration** (or Phase 6 Packaging/Release Candidate sign-off) once all stacked PRs #6–#11 are reviewed.

## Provider.5 — Kimi Code ACP Runtime Integration (Completed Offline / Host CLI Absent)

1. Install Kimi Code CLI (`kimi`) and run `kimi login` when explicitly authorized to verify live `kimi acp` interoperability using `docs/extensions/provider5-kimi-acp.md`.
2. Consider a shared OpenAI-compatible provider adapter (`OpenRouter`, `LM Studio`, `llama.cpp`) reusing `ghost-bot.provider` `SecretStore`, `assertApprovedHttpsUrl`, and SSE parsing.

## Provider.4 — Google Gemini API Integration (Completed Offline / Execution Gated)

1. When explicitly authorized for live API testing, configure a Gemini API key in Settings -> Accounts & Providers and run the 2-request bounded live acceptance procedure in `docs/extensions/provider4-gemini-api.md`.
2. Proceed to **Provider.5: Moonshot Kimi ACP Integration** (protocol-tested offline with `kimi` CLI availability check and strict ACP framing/approval boundaries).

## Provider.3 — Anthropic Claude API Integration (Completed Offline / Execution Gated)

1. When explicitly authorized for billed API testing, configure an Anthropic API key in Settings -> Accounts & Providers and run the bounded one-turn live acceptance procedure in `docs/extensions/provider3-claude-api.md`.
2. Proceed to Google Gemini API-key integration (`Provider.4`) using the same isolated provider credential namespace, official `generativelanguage.googleapis.com` endpoint pinning, and explicit opt-in gates.

## Provider.2 — Ollama Local Runtime Production Integration (Completed Offline / Host Prerequisite Open)

1. Install Ollama locally and pull a lightweight local model (e.g., `qwen2.5:1.5b` or `llama3.2:1b` for the host's 13 GiB RAM / 4.9 GiB available / RTX 3050 Mobile) when explicitly authorized.
2. Run the bounded one-turn local inference acceptance procedure in `docs/extensions/provider2-ollama-local.md`.
3. Proceed to the next provider milestone (e.g., Anthropic Claude / Google Gemini API-key opt-in or Kimi ACP if CLI is installed).

## Phase 3D.4 — Integrated End-to-End Acceptance

1. Verify combined Memory + Knowledge + MCP production workflows in Electron and daemon regression suites on the integrated branch.
2. Verify Linux AppImage & Fedora RPM packaging builds and smoke launches on the integrated codebase.
3. Confirm release-candidate security sign-off (noting OS Secret Service keyring stub status for `secretRefs` and `unsupported_native_mcp` for Codex `0.172.0` / opt-in live verification requirements) before merging to `main`.

## Earlier Phase 3D.3 plan (Completed)

1. Add coordinated migration `0007_mcp_core` for `mcp_servers` (storing configuration and opaque `secretRefs` only, never raw secrets) and `mcp_approval_bindings`.
2. Wire `@ghost-bot/mcp` behind daemon-owned `McpService`, `HostMcpPolicyAdapter` in `RuntimePolicyBroker`, and durable approval binding in `RunOrchestrator`.
3. Follow with Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 3D.2 plan (Completed)

1. Add coordinated migration `0006_knowledge_core` for `knowledge_collections`, `knowledge_documents`, `knowledge_document_revisions`, `knowledge_chunks`, and `knowledge_chunks_fts`.
2. Wire `@ghost-bot/knowledge` behind a daemon-owned `KnowledgeService` with `buildValidatedKnowledgeContext` at the dispatch boundary and document management UI.
3. Follow with Phase 3D.3 (MCP Foundation) and Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 3D.1 plan (Completed)

1. Design and apply SQLite migration `0005+` for daemon-owned Memory integration while preserving `0001`–`0004` compatibility.
2. Wire `@ghost-bot/memory` into `apps/daemon` with explicit consent boundaries, `RuntimePolicyBroker` enforcement, and typed IPC in `packages/shared-types/ipc.ts`.
3. Follow with Phase 3D.2 (Knowledge & Retrieval), Phase 3D.3 (MCP Foundation), and Phase 3D.4 (Integrated End-to-End Acceptance).

## Earlier Phase 2E plan (Completed)

1. Build and verify the Fedora RPM package (`pnpm package:rpm`) in an environment with `libcrypt.so.1` (`libxcrypt-compat`) or system `fpm` (`USE_SYSTEM_FPM=true`).
2. Complete remaining Phase 2 items: OpenClaw Gateway adapter (if verified), optional local Ollama adapter, and usage source/reset timestamp polish.
3. Keep `full-access` (`dangerFullAccess`) and persistent `Approve Always` gated until explicit verification.

## Earlier Phase 2 plan

Phase 1 (1A–1D) Desktop Foundation is **Verified** and ready for acceptance review. Next milestone: **Phase 2 — Functional MVP**:

1. Wire live chat execution (`runs.start`, `runs.cancel`, `approvals.resolve`) through the daemon `RuntimePolicyBroker` and `CodexAppServerAdapter` (preserving `read-only`, `ask-approval`, and `workspace` sandboxing with `excludeSlashTmp: true`).
2. Persist sessions, runs, run events (`RuntimeEventV1` with monotonic `seq`), and messages transactionally in SQLite (`apps/daemon/src/db/`).
3. Surface real tool activity, approval requests, diff previews, and cancellation in the desktop workspace.
4. Implement native OpenClaw Gateway WebSocket adapter and optional local Ollama adapter after live verification.

Start with [progress](PROGRESS.md), [protocol](PROTOCOL.md), and [provider matrix](PROVIDER_MATRIX.md).

## Alpha.3A release handoff

Review the focused CSP harness change. After UI refinement, build the approved final SHA once and execute [Alpha.3A packaging readiness](extensions/alpha3a-packaging-readiness.md) on provisioned Fedora and Ubuntu desktops. Record hashes and exact source SHA for every result. Preserve all migrations and current capability gates.

## Targeted save correction handoff

Review the PR #47 test-only save completion wait and its focused evidence. Let hosted CI verify the complete suite at the new head, then continue the documented final-build acceptance after UI refinement. Preserve the accepted capability scope.

## Alpha.4B handoff

Review actual Workspace screenshots against the approved V03.2 archive. Agent 1 reconciles the Workspace draft with the completed shared UI and wires Tools navigation, canonical Usage ownership and coordinated persisted width bounds. Preserve both histories and current capability gates. Then obtain maintainer visual approval before final RC freeze and package acceptance. See [Alpha.4B Workspace UI review](extensions/alpha4b-workspace-ui.md).
