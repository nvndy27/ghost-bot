# RC2.1 — Real Runtime & Provider Selection

## Checkpoint

- Branch: `fix/rc2-real-world-usability`
- Frozen source parent: `3af223e2f680df8facee143d6210aefd190ce0ef` (tree `e69e0e34ace901bf511612d0f83a115610dede5d`)
- RC2.1 implementation commit: `011cdc1b7f1c9af4da08996f1a62220365a926e3`
- Diagnosis was committed separately before this implementation. The RC1 worktree, source, artifacts and PR #53 were not modified.
- Status: **Tested** offline and in source Electron. Hosted checks and independent review remain pending.

## Corrected behavior

`RuntimeRegistry`, the existing adapters, `RuntimePolicyBroker` and `RunOrchestrator` remain the runtime owners. The authenticated daemon now projects ten known runtime entries (nine providers plus Mock Offline) over a Zod-validated HTTP/IPC contract. Each entry reports installation/availability, configuration, authentication, model discovery state and timestamp, actual model IDs and labels, model-specific efforts, supported permissions and tools/attachments, execution readiness, a bounded reason, and redacted diagnostics. The optional selected-bot projection identifies the exact blocking condition. A catalog generation is bound to the provider/account/configuration and observed capability list; it remains stable across status reads when those facts do not change.

Provider catalog behavior is deliberately adapter-specific:

| Runtime | Discovery exposed by the projection | Effort and execution boundary |
| --- | --- | --- |
| Codex App Server | Installed CLI version, `account/read`, and actual App Server `model/list`. | Preserves every reported model effort. Only the verified ChatGPT subscription route is eligible; API-key auth and `full-access` remain rejected. Execution still requires exact model, supported permission, canonical workspace, and policy authorization. |
| OpenClaw Gateway | Configured loopback Gateway status and `models.list` metadata. | Thinking levels appear only when reported. Gateway reachability does not prove upstream entitlement. Live execution remains policy-gated pending sandbox and billing acceptance. |
| Claude API | Existing `/v1/models` adapter, only after explicit discovery request, configured credential, and existing execution authorization. | Adapter reports no effort choices. Tool-free API execution remains subject to spend consent and the existing gate. Claude.ai subscription access is unsupported. |
| Gemini API | Existing `v1beta/models` adapter, under the same explicit discovery authorization boundary. | Adapter reports no effort choices. API key and billed execution remain opt-in. Consumer account login is unsupported. |
| Kimi ACP | Actual ACP initialization metadata when the CLI is available. | Only negotiated metadata is shown; no efforts are invented. Filesystem and terminal callbacks remain rejected and execution remains gated pending interoperability acceptance. |
| Ollama | Actual local `/api/tags` model list when its loopback service is available. | No effort choices are invented. Local tool-free execution remains separately authorized and live local inference is unverified. |
| LM Studio | Actual models from its configured loopback OpenAI-compatible endpoint. | No effort choices are invented. Endpoint availability does not establish a model-specific sandbox; execution authorization remains separate. |
| llama.cpp | Actual models from its configured loopback OpenAI-compatible endpoint. | No effort choices are invented. Host service availability and live inference remain unverified. |
| OpenRouter API | Existing `/models` adapter, without provider fallback. | No effort choices are invented. It is an API-billed route, not subscription access; live spend remains gated. |
| Mock Offline (non-provider) | Its fixture catalog is present only when the process was explicitly launched in mock mode. Real mode returns no Mock catalog. | Local mock execution is visibly labeled and never selected as fallback for a real provider. |

Unknown, unavailable, stale, unauthorized and failed catalogs remain distinct. A cached prior catalog can be shown as stale with its prior generation; it cannot be silently treated as newly discovered. External API catalog calls are never triggered by status polling. The user must request discovery, and the daemon rechecks the configured credential and existing authorization before making the adapter call.

## Bot, composer and first-run behavior

Bot Editor and Chat Composer share `ProviderModelControls`. They use the daemon catalog only, preserve arbitrary provider-reported effort strings, and do not offer mock model names in real mode. A real-provider or model/effort/permission change must select a currently observed model and supported values. The daemon checks the catalog generation and effective configuration again before persistence and dispatch. An unavailable saved model remains visible as an unavailable saved value; it is not rewritten. Chat Send depends on the daemon's selected-bot readiness and is disabled while a changed selection has not been applied.

Fresh ordinary production profiles now have no automatically seeded bots. The first-run surface directs the user to provider setup or explicit bot creation. Existing mock-configured bots keep their identity, avatar, workspace, conversations and mock configuration; the editor explains that state and requires an explicit provider/model change. The mock provider can remain shown as the existing configuration, but its unavailable real-mode model is not presented as a current catalog. Explicit demo mode remains a process launch choice (`GHOST_BOT_RUNTIME_MODE=mock`); no real bot is converted to demo mode.

Routing changes are persisted through the existing bot record. Catalog generation is request validation data, not a database column. The existing session/config snapshot lifecycle creates a fresh compatible conversation when routing changes; prior conversations and active runs keep their original provider/model snapshot. No migration or dependency was added.

## Security and capability limits

- The renderer receives status and capability facts only. Daemon policy and `RunOrchestrator` remain authoritative at dispatch; IPC sender validation, daemon token authentication, request Zod validation, secret redaction, and credential-store boundaries remain in force.
- A selected configuration is not called ready because another provider is installed or connected. Runtime availability, authentication, a real matching model, model effort support, workspace requirements, and policy authorization are evaluated separately.
- There is no automatic API-key fallback for Codex, no real-to-Mock fallback, no fabricated model/effort/quota, no `full-access`, and no new Workspace/terminal capability.
- Each provider currently has the existing account configuration model; this work does not add multiple accounts per provider or cross-account routing.
- A new production profile has no demo bot seed. To use the existing offline demo seeds, an operator must deliberately start the process with the mock runtime mode. The runtime mode is process-wide and is not switched inside the running app.

## Focused evidence

The actual Electron test uses a disposable HOME, XDG directories, data profiles and a synthetic workspace. It verifies the empty production first-run, absence of mock catalog models in real mode, installed-but-auth-required Codex, preserved existing mock bots and disabled Send. A private disposable executable then implements only fixture `initialize`, `account/read`, `model/list`, rate-limit metadata and session start/resume responses. It supplies a clearly synthetic ChatGPT account and model catalog, including `xhigh` and `max`; it does not implement `turn/start` and cannot contact a provider. The real Electron UI selects the fixture model and `max` effort, saves the compatible session, and restores the same bot/model/effort/permission and active session after app restart. Electron's actual window preferences reported sandbox and context isolation enabled and Node integration disabled. Screenshots are kept outside Git at `/home/nguyenduy/Documents/Projects/ghost-bot-coordination/rc2/provider-acceptance/`.

The tests exercise protocol fixtures and the source Electron application; they do not establish the maintainer's current subscription state, live model discovery against that account, live inference, API billing, or packaged behavior. No login, secret inspection, live inference, API request, package build, schema migration or dependency change was performed.

## Handoff

After focused independent review and the candidate's required hosted checks, RC2.2 should correct default and legacy tilde workspace paths, add Workspace Open Folder/switching, and verify native read consent, editor save consent, disk persistence and Ctrl+S against a synthetic project. That work should not broaden group or AI-mediated filesystem authorization.
