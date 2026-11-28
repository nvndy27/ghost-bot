# RC2.0 — Real-World Usability Diagnosis and Architecture Plan

Date: 2026-11-28

## Scope and checkpoint

This is a diagnosis and plan, not an implementation. It is based on frozen RC1 commit
3af223e2f680df8facee143d6210aefd190ce0ef, tree
e69e0e34ace901bf511612d0f83a115610dede5d. The isolated worktree is
fix/rc2-real-world-usability at
/home/nguyenduy/Documents/Projects/ghost-bot-worktrees/ghost-bot-rc2. The RC1 source,
artifacts, evidence, PR #53 and integration worktree were not changed. The only tracked
changes in this branch are diagnosis documentation.

RC1 is on hold. This document does not authorize a provider request, an account login, a
permission change, a package build, merge, tag, freeze or release. No live inference ran.

## Diagnosis verdict

The reported provider/model mismatch is reproducible in source and in actual Electron:

- New installs seed five bots as mock-offline with mock model IDs in
  apps/daemon/src/db/seed.ts:18-100.
- BotEditorModal uses MOCK_MODELS for Codex, OpenClaw, Kimi, LM Studio, llama.cpp and
  OpenRouter; it only loads dedicated catalogs for Ollama, Claude API and Gemini API.
  Codex effort values are hard-coded as low/medium/high instead of taken from the
  selected model. See apps/desktop/src/components/BotEditorModal.tsx:100-119 and
  565-725.
- ChatComposer selects MOCK_MODELS whenever the bot is non-Codex, even when the daemon
  is running in Codex mode. Readiness is global mock mode or a live-ready Codex bot.
  A non-Codex configured bot is therefore presented with mock models but cannot send
  in live mode. A selected Codex model is not checked against the catalog in the
  renderer before enabling Send. See apps/desktop/src/components/ChatComposer.tsx:55-74.
- ChatHeader renders “Codex Ready” whenever the app is not in global mock mode; it does
  not check account connection, selected bot runtime, model availability or execution
  authorization. See apps/desktop/src/components/ChatHeader.tsx:137-140.
- App.tsx treats GHOST_BOT_RUNTIME_MODE as a global mock-versus-Codex mode. That mode is
  not the selected bot provider. RuntimeSnapshot is also global Codex/mock state, not a
  catalog or readiness state for every provider.
- RuntimeRegistry.listProviders() returns Mock in mock mode and only Codex, OpenClaw
  and Ollama in Codex mode. Other providers have separate status methods and IPC
  routes; BotEditor does not consume all of them. This splits status, catalog and
  readiness across different surfaces.
- Actual Electron with a fresh temporary HOME and no credentials reported runtime
  mode codex, status auth-required, authStatus disconnected, while the seeded Chief
  bot showed model gpt-6.2-mock, header “Codex Ready” and Send disabled. No account
  data was read and no login or inference occurred.

The reported Workspace failure is also reproducible:

- Seed paths are literal tilde strings such as ~/Projects/ghost-bot and ~/Documents.
  apps/daemon/src/workspace/files-service.ts:459-463 rejects any non-absolute path.
  BotRepository expands and canonicalizes user-selected paths, but initial seed inserts
  bypass that repository validation.
- In actual Electron, a fresh profile and synthetic project still showed
  “No authorized workspace root configured.” The Allow read access button appears,
  but Electron main first resolves the daemon context and cannot open the native
  chooser until the bot has an absolute workspace path.
- Updating the disposable bot path through the existing validated updateBot IPC to a
  synthetic absolute path changed the UI to “Allow read access to this bot workspace.”
  The native read consent was not granted.
- Workspace Files has no direct Open Folder action. The only path chooser is in
  BotEditorModal; the Workspace tab then has a separate native read grant step.
  Switching directories therefore requires leaving Workspace and editing the bot.
- The server rejects team workspace context unless an authorized task scope exists.
  Group membership or a bot’s shared workspace path does not grant group access.

No source-level evidence establishes the maintainer’s current ChatGPT Plus account
state. The Codex metadata probe used a new empty temporary profile and returned
auth-required. A bounded real Codex request requires a separate explicit maintainer
authorization. The source build and Electron inspections are not packaged RC1
acceptance. The read grant, populated tree, editor save, disk verification and Git
changes flow were not exercised because native consent was not granted.

## Provider/runtime capability and readiness matrix

The word “connected” must describe the underlying connection it actually checked. It
must not imply that a model is available or execution is authorized. Provider facts
below describe current adapter code and the historical evidence in
docs/PROVIDER_MATRIX.md; host availability is not freshly asserted unless stated.

| Runtime | Installation/configuration and account signal | Model discovery and effort | Execution capability and current gate |
| --- | --- | --- | --- |
| Codex App Server | Codex CLI version detection; dedicated Ghost Bot Codex profile. account/read distinguishes no account, ChatGPT subscription and API-key account. | App Server model/list is dynamic. Supported reasoning efforts are model-specific metadata from the returned model entries. | Real streaming, session resume and sandbox-backed permission modes exist. ChatGPT subscription path was previously live-verified; current maintainer account was not inspected. API-key fallback is rejected. Full Access remains disabled. |
| OpenClaw Gateway | Adapter probes the configured loopback Gateway and Gateway auth. Gateway connection does not prove upstream provider billing or account access. | models.list supplies actual IDs and names; effort choices are exposed only when the Gateway reports thinkingLevels. | Adapter execution exists, but policy keeps it gated until upstream sandbox and billing enforcement are verified. |
| Anthropic Claude API | Anthropic API key is held through the OS Secret Service. API execution/discovery requires the existing explicit authorization setting. Claude.ai subscription credentials are not supported. | Official /v1/models response; no effort metadata is supplied by this adapter. Discovery is not attempted without explicit opt-in and a configured key. | Tool-free read-only streaming implementation is protocol-tested. API-billed live execution remains gated for acceptance and explicit opt-in. |
| Google Gemini API | Gemini API key uses the OS Secret Service and explicit execution authorization. Consumer Google account login is not supported by this adapter. | v1beta/models filtered to generateContent models; no effort metadata is supplied. Discovery is not attempted without explicit opt-in and a configured key. | Tool-free read-only streaming implementation is protocol-tested; billed live execution remains gated. |
| Kimi Code ACP | Requires the kimi CLI, ACP v1 negotiation and the user-managed kimi login state. ACP authenticated status is separate from policy authorization. | Model list comes from ACP initialize negotiation; efforts are empty because the adapter does not report model-specific efforts. | Streaming/session support exists, but client fs/* and terminal/* requests are rejected. Policy execution is gated pending live interoperability and boundary acceptance. |
| Ollama | Local loopback service availability is checked separately from installed CLI. | /api/tags returns installed local non-cloud models; effort metadata is empty. | Local tool-free read-only execution is implemented and protocol-tested; live local inference is unverified and remains gated by authorization. |
| LM Studio | Requires the configured loopback OpenAI-compatible server. “Available” means the local endpoint answered, not that a model is running or cloud routing is impossible. | /v1/models returns endpoint models; effort metadata is empty. | Tool-free read-only chat exists with explicit execution authorization. Loopback fixtures are verified; host binary/listener and live local model acceptance are unverified. |
| llama.cpp | Requires its configured loopback OpenAI-compatible server. | /v1/models returns endpoint models; effort metadata is empty. | Tool-free read-only chat exists with explicit execution authorization. Loopback fixtures are verified; host binary/listener and live local model acceptance are unverified. |
| OpenRouter API | API key is held in OS Secret Service; explicit API-billed execution authorization is separate. This is not a subscription adapter. | OpenAI-compatible /models response; this adapter exposes no effort metadata. The endpoint is pinned and provider fallbacks are disabled. | Tool-free read-only execution is implemented and synthetic-transport tested. Live API execution is gated; no paid request was made. |

The Mock Offline Runtime is a tenth, non-provider execution target for explicit tests and
offline UI demonstration. Its fixed catalog and deterministic responses must never be
presented as a real provider catalog or as recovery from failed real execution.

## Proposed shared provider/runtime contract

Reuse RuntimeRegistry, existing provider adapters, provider-specific status methods,
providerSecretStore, RuntimePolicyBroker, RunOrchestrator, RuntimeSnapshot, ModelInfo,
SessionConfig and persisted run snapshots. Do not create a second runtime registry or
authorization engine.

Represent these independent facts in a daemon-owned provider capability response:

1. Adapter installed — this build contains the adapter; for local/CLI providers also
   report whether the required local executable or service is detected.
2. Provider configured — required endpoint/options or credential reference exist.
   Never return credential values.
3. Account connected — the provider’s own auth/handshake check succeeded. Do not infer
   upstream account access from a reachable OpenClaw Gateway or a listening local API.
4. Models available — actual discovered catalog is non-empty and observed at a stated
   time. Static mock models are only returned for the explicit mock runtime.
5. Execution authorized — the existing policy broker and existing explicit
   provider-consent state allow this exact mode. This is not equivalent to connection.
6. Selected bot ready — its persisted runtime, account/profile, model, supported effort,
   permission mode, compatible session and required workspace meet the above conditions.

The catalog is bound to provider/account and a generation or observation identity.
Each model reports only upstream-observed efforts and capabilities. An empty effort
list means no effort choice is exposed; it is not a guessed default. Selection and
dispatch validate against the same catalog generation. The renderer displays daemon
readiness and errors; the daemon remains authoritative.

Existing schema already contains provider_accounts, model_profiles, agents.model_profile_id,
agent runtime/model/effort columns and session account_id/runtime_id. Current BotRepository
does not populate or hydrate model_profile_id. First implement a schema-free single-account
path by wiring the existing profile relationship and session identity. Add no migration
unless focused tracing proves this existing relationship cannot represent a required
bot/account configuration. Migrations 0001–0014 remain frozen.

## RC2.1 — Real Runtime & Provider Selection

**Verified root causes:** seeded bots persist mock runtime/model IDs; model options in the
Bot Editor and composer do not share the daemon catalogs; header/readiness describes the
global mode rather than the selected bot; provider status is fragmented; UI-selected
efforts can be invented or stale.

**Proposed production boundaries:** apps/daemon/src/runtime/registry.ts for a single
daemon-owned aggregation over existing adapter/status methods; apps/daemon/src/server.ts
for validated read-only catalog/readiness routes; shared-types/ipc.ts,
apps/desktop/electron/main.ts and preload.cts for bounded DTOs and sender-checked IPC;
BotEditorModal.tsx, ChatComposer.tsx, ChatHeader.tsx, App.tsx and sidebar provider labels
for one provider-aware selection/readiness model; BotRepository and
RunOrchestrator for persistence and final dispatch validation. Existing provider-specific
status APIs remain the source of account/configuration information.

**Required behavior:** no live bot control renders MOCK_MODELS. Mock catalogs are only
shown for an explicitly configured mock bot in offline/mock mode. A real catalog failure
disables send and explains the failure; it never changes provider/model or returns a mock
reply. Effort is populated per selected model from observed metadata. Do not silently
convert mock bots: preserve bot ID, name, avatar, instructions, permission and histories;
offer an explicit configure-real-provider action, then require a compatible new
conversation when account/runtime/model identity changes.

**First-run UX:** explain that no provider is connected; offer supported Codex account
connection as the primary path; show its actual account and discovered catalog; then let
the user configure an existing bot or create one, select an available model and only
supported effort, and choose permission/workspace. Keep other seeded bots explicitly
Offline Mock until the user changes each one. A user can return to their existing bots
without losing identities, avatars, settings or sessions.

**Security impact:** no authorization expansion. Discovery is read-only and only invokes
existing adapter methods when its existing prerequisites/consent permit. Secret values
stay in the daemon/keyring. Every run rechecks provider generation, catalog membership,
account binding and RuntimePolicyBroker decision before dispatch. Existing
config_snapshot_json and session compatibility checks remain in force.

**Schema/adapter assessment:** the UI/status mismatch can be fixed without a new DB
schema or new adapter. The existing model/profile/session fields and adapter listModels
methods provide the first slice. Some providers genuinely expose no effort or tool
metadata; do not fill those gaps with guessed values. If provider discovery requires
additional metadata consent, keep it opt-in.

**Focused regression coverage:** global mock versus provider identity; each provider’s
unavailable/configured/connected/catalog states; no MOCK_MODELS in real selectors;
Codex model-specific effort list; unknown/stale model and effort rejection; no
mock-response fallback on a real dispatch failure; permission gates; persisted provider
selection; session compatibility on account/model changes; unchanged bot/avatar/session
identity during explicit migration UX.

**Electron acceptance:** fresh disposable profile, mock runtime first to verify explicit
mock labeling, then a no-credential temporary Codex profile to verify truthful
auth-required UI. Operator then uses the official Codex connection flow only after
separate authorization, confirms discovered subscription account and models, configures
one existing bot, and performs one bounded Codex smoke request only after separately
authorized. No authentication or inference is part of this diagnosis.

**Limitations and acceptance:** Codex is the primary real-world provider target. Other
adapter catalogs and execution remain per the matrix; implementation does not make an
unsupported provider ready. Accept only when the selected bot’s label, catalog, effort
and Send state all reflect actual daemon metadata and the server dispatches the exact
persisted selection without fallback.

## RC2.2 — Real Workspace

**Verified root causes:** raw tilde seed paths fail the daemon’s absolute-path requirement;
directory switching is available only in Bot Editor; native read consent is a separate
Workspace action. Group scope is explicitly denied without an authorized task scope.

**Proposed production boundaries:** fix new seed defaults in apps/daemon/src/db/seed.ts
to use a valid absolute home-derived path, without changing existing bots silently.
Provide an Open Folder action in Workspace Files using the existing native directory
picker, validated BotRepository update and daemon workspace context. Follow selection
with an explicit, clearly worded read-consent action; pass only the chosen canonical
root to the existing daemon grant validation. Reuse WorkspaceFilesTab.tsx,
WorkspacePanelShell.tsx, App.tsx, existing workspace pick/read IPC in main.ts/preload.cts,
BotRepository, WorkspaceFilesService and the existing generation-bound grant maps.
Switching roots must invalidate the old grant and stale tabs before displaying the
new root.

**Shortest safe workflow:** Workspace → Open Folder → native directory picker →
explicit “Allow read access” confirmation → authorized tree → open text file → edit →
Ctrl+S → verify disk contents → see the resulting read-only Git change. Persist the
selected folder as that bot’s workspace setting. Do not route users through Bot Editor
to switch it. For existing tilde-seeded bots show a corrective chooser; do not rewrite
their path or grant access silently.

**Editor capabilities:** preserve Explorer-left/Editor-right, 145px default Explorer,
existing resizable divider, collapse and narrow overlay, multiple tabs, syntax view and
Ctrl+S (already implemented in WorkspaceCodeEditor.tsx:106-114). Preserve daemon
canonical containment, native read grant, workspace identity/auth generation, optimistic
revision and conflict checks. Manual editor save is distinct from model-authored file
operations.

**Write boundary:** only existing supported manual text save and empty file/folder
creation after bot Workspace permission, active native read grant and explicit
time-limited write consent. The current write confirmation is daemon-bound for 30
minutes. Rename and delete remain unavailable. No group filesystem access, private-task
scope inheritance, terminal access or permission broadening is part of RC2.2.

**AI-mediated workspace limitation:** Codex is the existing tool-capable runtime with
verified permission modes and workspace sandboxing. Claude, Gemini, Ollama and
OpenAI-compatible local/cloud adapters are tool-free read-only chat; Kimi rejects client
filesystem and terminal callbacks; OpenClaw execution is gated pending sandbox/billing
verification. Manual Workspace save therefore does not imply that every provider can
read/write files or run terminal commands. Keep all provider-specific AI operations
behind their existing gates.

**Focused regression coverage:** seed path and tilde repair prompt; native picker
cancellation; read grant exact-root matching; no grant without explicit consent;
canonical containment/traversal/symlink tests; workspace switch and generation revocation;
save revision conflict and disk contents; no write without Workspace permission and
active grant; team/private-task denial; rename/delete and terminal remain gated.

**Electron acceptance:** in a disposable profile, select a synthetic project via native
picker, read-consent it, navigate tree, open multiple files, edit/save with Ctrl+S,
verify exact disk content, modify externally to trigger conflict, revoke/switch folder
and confirm stale authorization fails, inspect Changes, test narrow Explorer behavior.
Operator action is required for the native read and write confirmation dialogs.

**Limitations and acceptance:** users must choose a real existing directory. The
workspace path is per bot. Read and manual-write grants remain distinct. Accept only
after real Electron demonstrates the above workflow with no bypassed grant or
out-of-root access.

## RC2.3 — Product UI Refinement

**Verified root causes:** Settings has 14 top-level sections; provider detail is split
across a global Codex card and provider-specific views; Bot Editor presents a large
mixed form and mock catalogs; Usage is canonical in the sidebar but only one global
Codex snapshot is available and current usage rows are text-only.

**Proposed production boundaries:** SettingsModal.tsx, ProviderUsage.tsx, BotEditorModal.tsx,
ChatComposer.tsx and shared token/style files. Coordinate the selector with RC2.1.
Preserve every existing callback, provider, permission setting, capability gate,
theme and avatar preset.

**Settings hierarchy:** seven top-level groups: General; Providers; Bots & Teams;
Memory & Knowledge; Tools & Automation; Permissions; Advanced. Preserve existing
subsections by nesting Appearance and Personalization under General; Accounts and
Models under Providers; bot/team management under Bots & Teams; Memory and Knowledge
as subsections; MCP, Computer Use and Routines under Tools & Automation; existing
permission settings under Permissions; privacy, runtime diagnostics and rare controls
under Advanced. Do not remove settings during reorganization.

**Provider and Usage presentation:** compact provider rows show provider identity,
account label, connection, discovered-model and execution-ready states separately,
plus Connect/Manage. Move endpoint/version/timestamp/sandbox/transport/error details
into expandable diagnostics. Keep sidebar Usage Center canonical. Display only actual
provider/subscription identity and usage windows. Use remaining-quota bars only when a
real reported percentage exists; preserve null as unavailable. Normalize 300m to
five-hour and 10080m to Weekly only when that actual window value was reported. Show
local reset time, observation time, refresh/close icons and Manage Providers. No
invented zero, quota or reset. Retain stale, refreshing, unavailable and error states.

**Bot Editor and composer:** prioritize name, avatar, provider, model, supported effort,
instructions, workspace and permission. Put secondary controls in collapsed advanced
sections. Use the same daemon-owned provider/model/effort readiness as runtime dispatch.

**Security and schema:** no DB migration or authorization change is required for layout,
provider details or usage presentation. Do not reveal key values or raw secrets/errors.
Respect provider-specific metadata opt-ins and capability gates.

**Focused tests and Electron acceptance:** verify each setting remains reachable and
persists; provider labels/status are accurate; empty model/effort metadata does not get
fabricated; null quota shows unavailable without a bar; supported raw quota windows
normalize correctly; refresh errors and stale state are visible; keyboard navigation,
focus, dark/light/system themes and narrow layout work. Exercise the grouped Settings,
Usage and Bot Editor using synthetic provider DTOs and actual Electron.

**Limitations and acceptance:** Usage for any provider without an authoritative
usage-window API remains unavailable. A compact UI cannot imply a provider is ready.
Accept only with parity for all existing controls and no fabricated provider/model/
quota state.

## RC2.4 — Integrated Real-World Acceptance

**Dependencies:** RC2.1 provider contract and actual model-selection flow; RC2.2
workspace selection/read/save flow; RC2.3 simplified product surfaces; independent
CA2/A2 acceptance after CA1 publishes a candidate. RC2.1 and RC2.2 can progress
independently; RC2.3 provider selectors depend on the RC2.1 shared contract.

**Acceptance sequence:** first run in a new disposable profile; configure Codex with
the supported official flow under explicit operator control; confirm account-connected,
actual models and selected-bot readiness without exposing credentials; configure one
existing bot without changing its identity; create a new conversation if provider
compatibility requires it; send one minimal request only after separate explicit
maintainer authorization. Then choose a synthetic project, grant personal read access,
verify file tree/open, obtain explicit manual write consent, save one synthetic text
change and confirm it on disk and in read-only Changes. Switch workspace and bot,
confirm grant invalidation and isolation. Verify non-Codex providers stay honestly
unavailable or gated where acceptance is missing. Run restart and theme/compact
regression on the integrated candidate.

**Focused verification:** changed-path lint/typecheck/build, specific regression suites,
and one actual Electron acceptance path. Keep mock/module tests separate from actual
Electron and any separately authorized live Codex inference. Package acceptance is a
later, distinct CA2 task; this diagnosis does not establish packaged behavior.

**Security and acceptance:** no new permission model, no group filesystem, no
provider fallback, no hidden login or secret inspection, no AI execution outside the
provider’s accepted capability. Keep migrations 0001–0014, sandboxing, approvals and
credential isolation. Release remains blocked until real-world acceptance and
maintainer release decisions are complete.

## What can be fixed without schema, auth-model or adapter replacement

- Replace mock catalog fallbacks in renderer selectors with existing daemon catalogs;
  present unavailable instead of a fake model.
- Use provider-specific status and policy results to compute honest readiness.
- Correct the ChatHeader status and disable Send unless the selected persisted provider,
  model, effort and policy are ready.
- Make mock behavior explicit and add a non-destructive, per-bot configure-provider UX.
- Correct seed defaults and offer a workspace chooser for existing bad paths.
- Put Open Folder in Workspace and reuse current native picker, BotRepository validation,
  native read grant, generation revocation and write consent.
- Restructure settings, Bot Editor and usage display without changing persisted settings.
- Use existing provider_accounts/model_profiles/agents.model_profile_id and
  sessions.account_id before proposing a migration.

Do not replace provider adapters to solve a renderer catalog wiring defect. Adapter
changes are only justified if an existing adapter cannot report a capability actually
supported upstream or cannot enforce its already approved policy boundary.

## Verification performed for this diagnosis

- Frozen RC2 branch/worktree identity verified. RC1 integration worktree remains clean
  at the authorized SHA.
- Frozen-lockfile dependency installation completed in the RC2 worktree; Electron
  36.9.5 was present. No dependency manifest or lockfile changed.
- Source build completed. This was not an AppImage/RPM/package build.
- Actual source Electron launched with Chromium sandbox enabled in mock mode and in a
  fresh no-credential Codex profile. No live inference ran.
- Synthetic Workspace path and consent-state reproduction completed as described
  above. Read/write consent and file save were deliberately not performed.
- No automated test suite was run; unchanged accepted test evidence was not repeated.
- Screenshot evidence is local: /tmp/ghost-rc2-workspace-ungranted.png and
  /tmp/ghost-rc2-workspace-synthetic-consent.png.

## Recommended next assignment

Authorize CA1 to implement RC2.1 first on fix/rc2-real-world-usability, preserving
the exact RC1 parent history and all capability gates. Include the provider readiness
contract, actual catalogs in Bot Editor/composer, clear per-bot mock state, truthful
header/send readiness and regression tests. In the same focused root-cause correction,
make new seed workspace paths absolute and provide a non-destructive recovery prompt
for existing tilde-seeded bots. Continue RC2.2 after the provider selection contract
is reviewable; do not wait on independent review to develop unrelated UI surfaces.
CA2/A2 independently accepts the integrated candidate. Obtain separate maintainer
authorization before the bounded real Codex smoke request.
