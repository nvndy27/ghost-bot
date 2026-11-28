# Alpha.3B release readiness and provider acceptance plan

## Decision and evidence

v0.1 is **not released**. Alpha.1 and Alpha.2 are **Verified** within their independently accepted capability boundaries on main `bae63048978ea0188d784a4d53910f3fb31cd552`. PR #46 merged on 2026-11-27 from final head `c08c4a7344b03658f23d9d9a0b61bcbd5b1ea6f0`. Agent 2 accepted that head with no remaining integration blocker. Offline CI and CodeQL passed. This document is planning only. No inference, credential access, runtime installation, model download, package build or acceptance rerun was performed. [Acceptance](https://github.com/nvndy27/ghost-bot/pull/46#issuecomment-7224652321), [CI](https://github.com/nvndy27/ghost-bot/actions/runs/46042628210), [CodeQL](https://github.com/nvndy27/ghost-bot/actions/runs/46042628175).

The accepted head changes only three test expectations relative to integrated `1071688c48afd7006476002be1d01e28662a0ab5`. The three files passed 13/13 locally. Historical upgrade fixtures remain intact. Agent 2 reused the previous integrated review and package evidence for that test-only delta. Package evidence remains attributed to its actual source SHA.

Agent 2 recorded AppImage extract-and-run and extracted RPM mock delegation, group avatar restart persistence and personal/private Output isolation on `1071688`. AppImage SHA-256 is `affab8e6f40dc3e7c5178abf1746e53f7fb5622e142bbd70eb51659588ce3429`. RPM SHA-256 is `28e07c3ceede16284ba417fed6865b13bae28e878bfdb7524bfdfd7e79b631d4`. These establish scoped historical artifact evidence. Final release artifacts need the frozen release candidate and matching checksums. [Agent 2 artifact scope](https://github.com/nvndy27/ghost-bot/pull/46#issuecomment-7224652321).

## Release capability matrix

These evidence categories describe individual paths. A feature may have offline evidence while its live execution remains gated.

| Capability | Evidence category | Accepted boundary or next gate |
|---|---|---|
| Personal Codex subscription Chat | Live verified | Historical Alpha.0 CLI 0.172.0 completion, cancellation and restart/account continuity. Release-runtime compatibility needs a later authorized decision. |
| Bot organization, provider labels, conversations and unread state | Offline/protocol tested | Accepted persistence, switching and active-run routing with mock runtime. |
| Group membership, member routing and avatars | Offline/protocol tested | Scoped overrides, immutable routing snapshots and native validated avatar persistence. Other live routing catalogs remain limited. |
| Group discussion, delegation, approvals, cancellation and summaries | Offline/protocol tested | Accepted mock execution, exact private identity, uncertain cancellation and linked-output summaries. |
| Live Teams, multi-provider Group work and autonomous execution | Gated | Separate authorization and execution evidence required. |
| Personal Files read, search, preview and draft insertion | Offline/protocol tested | Native grants and generation revalidation. Explicit selection inserts only into its originating personal draft. |
| Personal text save and empty file/folder creation | Offline/protocol tested | Explicit native personal write consent in supported Workspace mode. External POSIX pathname races remain a documented limitation. |
| Non-empty creation, rename/delete, Ask Approval writes, unauthorized Group/task filesystem access | Gated | Safe publication or dedicated authorization unresolved. Files grants confer no Git mutation authority. |
| Git status, diff and bounded history | Offline/protocol tested | Native-authorized read-only isolated inspection. |
| Stage, unstage, revert and other Git mutations | Gated | Real index, HEAD and working-tree publication needs its own approved boundary. |
| Workspace Browser and Output | Offline/protocol tested | Local browser fixtures, lifecycle cleanup and bounded run output. Personal Output excludes private/team child runs. |
| Remote/public browser networking | Untested | Local HTTP acceptance does not establish external internet behavior. |
| PDF and Git isolation without required host tools/namespaces | Host prerequisite unavailable | Fail closed when Poppler, prlimit, Git or compatible Bubblewrap isolation cannot be established. Actual supported-platform inventory belongs to Alpha.3A. |
| Ollama, LM Studio, llama.cpp and Kimi actual runtime inference | Host prerequisite unavailable | Previously absent runtimes/listeners. No fresh host probe in this assignment. Adapter fixtures remain valid evidence. |
| Claude, Gemini and OpenRouter actual API inference | Gated | Protocol/transport evidence exists. Explicit account, spend and live acceptance remain required. |
| Full Access and native Codex MCP | Gated | Full Access disabled and native MCP unsupported. Keep host-mediated MCP consent and secret availability checks. |
| Installed RPM launcher, AppImage FUSE and Ubuntu desktop packages | Untested | Extracted artifacts and hosted CI do not establish installed desktop support. Agent 2 owns platform closure. |
| Windows and macOS release artifacts | Untested | No support claim without platform-specific evidence. |

The personal Codex live category is backed by the dated [Alpha.0 report](alpha0-final-live-acceptance.md). Fixture and IPC categories reuse the [unified progress evidence](../PROGRESS.md) and [Workspace report](alpha2g-workspace-convergence.md).

## Provider acceptance procedure and budgets

Nine production adapters are planned below. The mock runtime is a fixture. Priority is Codex, followed by whichever local runtime the owner already has installed with a suitable loaded model. Optional cloud/API and unavailable CLI paths follow only when separately authorized.

All budgets below are proposed upper limits, with zero automatic retries. This assignment authorizes zero requests. Metadata/discovery requests are distinct from generation turns. Record actual request totals, including background refreshes. Stop at the approved limit. Cancellation may still consume upstream tokens. If the adapter cannot apply a requested output cap, obtain agreement to a bounded runtime-specific limit before dispatch.

For every executed plan, use a synthetic prompt and disposable workspace/data profile through the normal Electron → IPC → daemon → adapter path. Disable optional retrieval, external tools and automatic provider refresh where supported. Capture the source SHA, package hash if used, OS/runtime version, redacted account identity, discovered model/effort, permission mode, request count, terminal events, response persistence, usage source and failures. Quotas remain unknown unless observed. Verify account/configuration changes cannot silently reuse an incompatible session. Stop on auth failure, unexpected billing/model substitution, unsupported configuration, timeout, missing sandbox, secret exposure or unconfirmed cancellation. Preserve existing policy denial instead of trying to bypass it.

### Codex subscription — first priority

Prerequisites are the compatible Codex App Server and the existing dedicated ChatGPT profile. Historical evidence is CLI 0.172.0. Discover the actual authorized model and effort before testing. Use official ChatGPT sign-in through Codex and runtime-managed credentials. API fallback requires a separate decision. [Official authentication, checked 2026-11-28](https://developers.openai.com/codex/auth/).

Proposed budget is three generation turns and at most six metadata RPCs, excluding initialization/control notifications. Reuse the established Alpha.0 procedure for a short read-only streamed response, an interrupted response, and a post-restart continuation. Verify the same canonical account/session and truthful cancel state. Expected evidence is redacted lifecycle events, persisted replies and external thread binding. Version/catalog mismatch or inaccessible prior thread fails acceptance. Full Access, native MCP and live Teams remain gated. [Existing three-turn procedure](alpha0-final-live-acceptance.md).

### Ollama — local priority when available

Prerequisites are an owner-managed loopback daemon and an already downloaded local model fitting host resources. The supported local API needs no authentication. Cloud models and credential-bearing URLs remain excluded. [Official authentication, checked 2026-11-28](https://docs.ollama.com/api/authentication).

Proposed budget is at most four metadata requests for version, tags, running models and selected-model details, then one read-only chat turn with at most 256 output tokens if supported. Verify streamed text, terminal completion, persisted history and local usage attribution. Remote/cloud model discovery, redirects, missing loaded model or policy denial stops acceptance. No model download is part of this plan. Actual local interoperability and any tool execution remain unverified. [Adapter limits and prior plan](provider2-ollama-local.md).

### LM Studio — local priority when available

Prerequisites are an existing loopback OpenAI-compatible server and an already loaded model. The present adapter uses the supported local endpoint without embedded credentials. If the server requires token auth beyond the adapter contract, report unsupported authentication. [Official compatibility and authentication entry points, checked 2026-11-28](https://lmstudio.ai/docs/developer/openai-compat).

Proposed budget is one model-list request and two chat turns, at most 256 output tokens each, with the second after app restart. Verify canonical history reconstruction, stable runtime/account identity and local usage labeling. Unavailable server, incompatible auth, redirects, changed endpoint or model mismatch fails the attempt. Model installation and live tool execution remain outside this acceptance. [Existing local contract](provider6-openai-compatible.md).

### llama.cpp — local priority when available

Prerequisites are an existing loopback llama-server, a loaded owner-selected model and API compatibility with the current adapter. An unauthenticated loopback configuration is the implemented path. A server requiring unsupported API-key configuration must remain unavailable. Consult the official server contract for the exact installed version before authorizing dispatch. The repository URL is retained as a reference because automated page retrieval was unavailable during this planning pass. [Official server documentation](https://github.com/ggml-org/llama.cpp/tree/master/tools/server).

Proposed budget is one model-list request and two chat turns capped at 256 output tokens each where supported. Restart between turns and verify reconstructed history and endpoint-generation binding. Missing model, incompatible responses, unbounded generation or changed endpoint stops acceptance. No build, model download or authentication bridge is authorized. [Existing adapter evidence](provider6-openai-compatible.md).

### OpenClaw Gateway

Prerequisites are the compatible loopback Gateway, scoped operator/device access, a known upstream account and independently verified sandbox and billing controls. Use Gateway-managed official pairing/authentication and the upstream provider-supported login. Gateway auth alone establishes no upstream entitlement. [Official authentication, checked 2026-11-28](https://docs.openclaw.ai/gateway/authentication).

Proposed budget is three metadata RPCs for health, status and models, followed only after the current execution gate is separately satisfied by one read-only generation turn. Require an agreed Gateway output/time bound first. Record Gateway and upstream identities separately, emitted usage and policy decisions. Missing sandbox enforcement, unknown upstream billing, excessive scopes or silent routing fails acceptance. Live execution remains gated until these prerequisites are approved. [Prior Gateway plan](provider1-openclaw-execution.md).

### Anthropic Claude API

Prerequisites are explicit API spend authorization, an owner-provided API account/key stored through the app keyring and a model actually discovered by the daemon. Use official API-key authentication with x-api-key and the adapter API version. Claude subscription login is not an accepted substitute for this adapter. [Official API overview, checked 2026-11-28](https://platform.claude.com/docs/en/api/overview).

Proposed budget is one discovery request and one read-only, tool-free Messages generation capped at 256 output tokens. Capture redacted headers/version, streaming lifecycle, completion and actual usage. Keyring failure, unavailable catalog model, redirect, invalid stream or unauthorized spend stops acceptance. Subscription token reuse and live Teams remain gated. [Existing procedure](provider3-claude-api.md).

### Google Gemini API

Prerequisites are explicit API spend authorization, compatible owner API key in the app keyring and an authorized discovered model. Use the official API key path through the x-goog-api-key header. Check current key type compatibility before use. [Official key documentation, checked 2026-11-28](https://ai.google.dev/gemini-api/docs/api-key).

Proposed budget is one model discovery request and one read-only streamed generation capped at 256 output tokens. Record terminal outcome, non-cumulative usage, safety response and any output-limit stop. Unsupported key type, query-string key, redirect, blocked safety result or missing catalog model fails the requested success case and must be reported truthfully. Consumer CLI login and live Teams remain outside this adapter acceptance. [Existing two-request procedure](provider4-gemini-api.md).

### Kimi Code ACP

Prerequisites are an installed compatible Kimi CLI and owner-completed official kimi login, with runtime-managed credentials. Verify ACP v1 interoperability and available model metadata before dispatch. [Official ACP contract, checked 2026-11-28](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html).

Proposed budget is at most three setup/metadata RPCs, two prompt turns and one cancel RPC. Complete one short read-only reply and cancel the second. Require an agreed output/time bound from the actual capabilities first. Record session identity, updates, denied filesystem/terminal requests and truthful cancellation or quarantine. Unsupported protocol, missing CLI/auth, permission escalation or uncertain termination prevents a successful acceptance verdict. Live tools and persistent permission grants remain gated. [Existing ACP evidence](provider5-kimi-acp.md).

### OpenRouter API

Prerequisites are explicit paid API opt-in, a key stored in the app keyring, discovered model availability and a maintainer-approved maximum currency spend in addition to the request limit. Use official Bearer API-key authentication. [Official authentication, checked 2026-11-28](https://openrouter.ai/docs/api/reference/authentication).

Proposed budget is one model-list request and one read-only streamed completion capped at 256 output tokens. Verify the requested model/provider route, allow_fallbacks false, persisted response, usage and account/configuration binding. Routing substitution, unexpected provider, unknown cost approval, redirect or key rotation fails/stops acceptance. Live API and live Teams gates remain until separately approved. [Existing transport contract](provider6-openai-compatible.md).

## User-facing limitations

v0.1 is an internal alpha candidate. Personal Codex Chat has historical live acceptance. Other adapters may show unavailable until their runtime/account and model are configured and their supported path is approved. Group discussion and Private Task execution currently have accepted offline mock evidence. They must not be advertised as verified live multi-provider collaboration.

Workspace access requires native consent. Consent can expire on restart or configuration changes. Personal Files supports bounded text save and empty creation only within its accepted grant scope. Rename, delete, Git writes and unauthorized task/group access remain unavailable. If an external application changes a file during save, the result may be uncertain and requires inspection before retrying.

PDF/Git require compatible Linux isolation and host utilities. Browser acceptance covers local fixtures. Installed desktop launcher behavior and platform support are limited to what Agent 2 records. Full Access, native Codex MCP and unverified autonomous features stay gated. Unknown quota and canceled-request cost cannot be presented as zero.

## Release checklist and final packaging handoff

- [x] Accepted main and PR #46 final CI/CodeQL and independent verdict recorded.
- [x] Alpha.1/Alpha.2 closed within verified capability boundaries.
- [x] Historical package evidence retains its exact build SHA and hashes.
- [ ] Agent 2 completes Alpha.3A readiness, including Linux dependencies, Issue #3/CU4-PKG-02 disposition and explicit platform support/gaps.
- [ ] Maintainer approves Alpha.3 readiness and any provider test budgets. Optional unavailable providers may remain unavailable with accurate capability labels.
- [x] Maintainer approved the V03.2 Alpha.4 UI acceptance scope.
- [ ] Maintainer records final visual/accessibility acceptance of the converged candidate and any concrete corrections.
- [ ] Freeze the final source SHA, release version, lockfile, migration history and supported capability matrix after approved corrections.
- [ ] Agent 2 builds and verifies final artifacts once from the frozen SHA using the existing packaging harness. Record hashes, environment, dependency preflights, exact scenarios and installed/extracted/FUSE distinctions. Any source correction requires a new candidate and corresponding affected evidence.
- [ ] Confirm internal alpha instructions, backup/recovery guidance, known limitations and audience against Alpha.3A evidence.
- [ ] Maintainer authorizes internal alpha distribution after reviewing the frozen evidence.
- [ ] Before public binaries, complete artifact-specific dependency notices/SBOM, reference artwork rights, contributor licensing, secret/history review, signing/provenance and the public distribution gates in open-source readiness.
- [ ] Maintainer explicitly approves publication, release notes and supported platforms. Until then v0.1 stays unreleased.

Agent 1 supplies this readiness plan. Agent 2 owns Alpha.3A, package dependencies, the harness and platform evidence. Final package acceptance follows Alpha.3 readiness, approved Alpha.4 UI acceptance and candidate freeze. Existing package tests are reused for readiness planning. Their prior results do not certify newly built release artifacts. [Distribution requirements](../OPEN_SOURCE_READINESS.md), [packaging harness](alpha2g-workspace-convergence.md#executable-alpha3-packaging-acceptance).

## Unified Alpha.4C and release-tooling checkpoint — 2026-11-28

**In Progress** — Draft PR #53 converges the independently accepted Alpha.4C correction head `63992bb9f8544fae8205e36f8ceafce333991bb7` with release tooling PR #52 at `9067aa4eb9dec411d70121c4aa6b84bcb2b91f05`, preserving both histories. The Alpha.4C correction delta is independently accepted. Hosted CI and CodeQL passed on exact convergence SHA `117a0c208247439f47442404e0cbdace92477806`; independent review then blocked that SHA on four release-runner findings. The targeted correction now passes 7/7 local synthetic regression tests; its published head still needs fresh CI and exact-head delta acceptance. Maintainer visual approval remains pending. This is not the frozen release candidate and does not certify a new package. The runner checks only the migration version/name prefix present in the previous artifact; it must not be described as package acceptance for migrations 0001–0014 without evidence from the actual artifacts. Artifact-to-artifact upgrade acceptance remains unrun because no distinct final candidate pair is available. Complete Alpha.3A host/platform acceptance and obtain explicit maintainer candidate-freeze approval before Agent 2's single final package build/verification. v0.1 remains unreleased.
