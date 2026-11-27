# Alpha.1 & Alpha.2A Shared Contracts and Ownership Handoff

> **Status:** Shared Baseline Handoff (Prepared with UI.1)
> **Accepted Alpha.0 `main` SHA:** `069c5511142139232b7ca48b0953dd41b4272a8d` (PR [#15](https://github.com/nvndy27/ghost-bot/pull/15) merge of accepted RC `31d146c94a8330b22008a5c32d77dbfb998fbcb2`, zero file-content delta vs `31d146c`)
> **Proposed Post-UI.1 Shared Baseline:** `main` after owner review and merge of the UI.1 Draft PR (`feat/ui1-icon-system-polish`)
> **Approved Ownership Record:** `~/Documents/Projects/ghost-bot-coordination/ALPHA-2-CONTRACT-APPROVED.md` & [PR #15 Comment](https://github.com/nvndy27/ghost-bot/pull/15#issuecomment-7209363228)
> **Reconciled Proposal:** `~/Documents/Projects/ghost-bot-coordination/ALPHA-2-CONTRACT-PROPOSAL.md`

---

## 1. Existing Canonical Contracts & Source Files

| Domain | Canonical Entity / Schema | Source File |
|---|---|---|
| Active bot identity | `BotRecord` (`agents.id`), `BotRecordSchema`, 12 avatar presets (`@ghost-bot/avatar`) | `packages/shared-types/ipc.ts`, `apps/daemon/src/bots/repository.ts`, `apps/desktop/src/components/BotAvatar.tsx` |
| Active session identity | `SessionRecord`, `SessionRecordSchema`, `MessagesListResponseSchema.session` | `packages/shared-types/ipc.ts`, `apps/daemon/src/sessions/repository.ts` |
| Group / team identity | `TeamRecordDto`, `CreateTeamIpcInput`, `UpdateTeamIpcInput` | `packages/shared-types/ipc.ts`, `apps/daemon/src/teams/service.ts` |
| Run identity & lifecycle | `RunRecord`, `RunStatus` (`pending`, `queued`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`, `interrupted`), `runs.config_snapshot_json` | `packages/shared-types/ipc.ts`, `apps/daemon/src/execution/orchestrator.ts`, `apps/daemon/src/execution/state-machine.ts` |
| Run output & tool events | `RunEventRecord`, `getRunEvents`, `ToolStep` | `packages/shared-types/ipc.ts`, `apps/daemon/src/execution/event-store.ts` |
| Authorized workspace root | `bot.workspacePath` (`agents.workspace_path`), `lstatSync` + `realpathSync` containment | `apps/daemon/src/bots/repository.ts`, `apps/daemon/src/terminal/service.ts` |
| File & tool permissions | `PermissionMode` (`read-only`, `ask-approval`, `workspace`, `full-access`), `RuntimePolicyBroker` | `packages/shared-types/permissions.ts`, `packages/shared-types/runtime.ts`, `apps/daemon/src/runtime/policy-broker.ts` |
| Panel size & collapsed state | `UiPreferencesSchema` (`theme`, `leftWidth` 180–380, `rightWidth` 220–420, `leftCollapsed`, `rightCollapsed`, `reducedMotion`) | `apps/desktop/src/state/preferences.ts` |
| Application preferences | `AppSettings`, `AppSettingsSchema`, `AppSettingsPatch` | `packages/shared-types/ipc.ts`, `apps/daemon/src/settings/repository.ts` |
| Shared functional icons | `IconButton`, `ICON_SIZE`, `ICON_STROKE`, `lucide-react` tokens (`--gb-icon-*`) | `apps/desktop/src/components/IconButton.tsx`, `apps/desktop/src/styles/tokens.css` |

---

## 2. Shared Bot Identity & Sidebar Contract (Mandatory)

- **12 Avatar Presets:** All 12 presets and `BotAvatar.tsx` rendering/editor behavior remain unchanged; never replace bot avatars with Lucide `Bot` icons.
- **User-Defined Bot Names:** Preserved across personal chats, groups, and workspace headers.
- **Sidebar Bot Row (`LeftSidebar.tsx`):** Displays **avatar, bot name, and provider label only**. Model names and reasoning effort must **not** appear in sidebar rows (they remain in Chat controls).
- **Provider Label Updates:** Reflects the bot's effective global runtime/provider and updates only after a successful provider change in Chat; team-scoped overrides in Alpha.1 must never silently mutate global bot configuration.
- *(Implementation note: `LeftSidebar.tsx` currently renders `bot.statusLabel` from `App.tsx`; switching sidebar sub-labels to effective provider labels is scheduled for Agent 1 in **Alpha.1A**.)*

---

## 3. Proposed New Contracts (Alpha.1 & Alpha.2)

| Contract | Owner / Proposer | Status | Scope & Notes |
|---|---|---|---|
| **Private task identity** (`taskId`, `parentTeamId`, `parentRunId`, `taskSessionId`) | Agent 1 (Alpha.1) | **Proposed** | Dedicated user-visible Private Task Chat linked to group/run; never injected into unrelated personal threads. |
| **Active workspace panel tab** (`overview \| files \| changes \| browser \| output`) | Agent 2 (`workspaceTabs.ts` in PR #16) -> Agent 1 wires persistence in `preferences.ts` / `App.tsx` | **Agreed in PR #16 (`WorkspaceTabId`), Persistence Pending** | Default `overview` preserves existing `RightPanel` + `TeamRightPanel` behavior; aligned to Agent 2's `WorkspaceTabId` in PR `#16`. |
| **Workspace scope & authorization** (`botId \| taskId`, canonical `workspacePath`, `permissionMode`) | Agent 2 proposes -> Agent 1 registers IPC/routes | **Requires Agent 2 & Agent 1 Agreement** | Daemon-enforced `lstatSync`+`realpathSync` containment; `read-only` blocks writes; fail closed on missing/untrusted root. |
| **Artifact references** (`path`, `kind`, `sessionId`, `runId`, `taskId`) | Agent 1 & Agent 2 | **Requires Agent 2 Agreement** | Stable relative paths under authorized workspace root for group summaries and Workspace Panel navigation. |
| **Error & unavailable states** | Agent 1 & Agent 2 | **Proposed** | Explicit gated/unavailable badges and non-color-only status text; never fabricate files, diffs, quotas, or output. |

---

## 4. File Ownership Matrix

### Agent 1 — Alpha.1 (Group Bot, Private Task Collaboration & Shared Infrastructure)
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/state/preferences.ts`
- `apps/desktop/src/components/LeftSidebar.tsx`, `ChatHeader.tsx`, `ChatComposer.tsx`, `MessageList.tsx`
- `apps/desktop/src/components/TeamWorkspaceView.tsx`, `TeamEditorModal.tsx`, `TeamRightPanel.tsx`
- `apps/desktop/src/components/IconButton.tsx`, `apps/desktop/src/styles/tokens.css`
- `packages/shared-types/ipc.ts` (and shared types)
- `apps/desktop/electron/main.ts`, `apps/desktop/electron/preload.cts`
- `apps/daemon/src/server.ts`
- `apps/daemon/src/db/migrations.ts`, `apps/daemon/src/db/schema.ts`
- `apps/daemon/src/teams/**`, `apps/daemon/src/execution/**`, `apps/daemon/src/sessions/**`
- Root `package.json`, `apps/desktop/package.json`, `pnpm-lock.yaml`

### Agent 2 — Alpha.2 (Right-hand Workspace Panel)
- `apps/desktop/src/components/RightPanel.tsx`
- `apps/desktop/src/components/WorkspacePanelShell.tsx`
- `apps/desktop/src/components/workspace/**` (tabs, hooks, components)
- `apps/daemon/src/workspace/**` (workspace-specific daemon services)
- Workspace-specific tests and documentation

---

## 5. Integration Workflow, Dependencies & Migration Allocation

1. **No Concurrent Edits to Shared Files:** Agent 2 must not directly edit Agent 1-owned files (`App.tsx`, `preferences.ts`, `TeamRightPanel.tsx`, `ipc.ts`, `main.ts`, `preload.cts`, `server.ts`, `migrations.ts`, `pnpm-lock.yaml`).
2. **Integration Request Workflow:** When Alpha.2 needs a new IPC channel, daemon route, Electron `WebContentsView` lifecycle hook, preference field, or dependency, Agent 2 submits a minimal, self-contained patch/interface spec in its PR/handoff for Agent 1 to review and wire.
3. **Migration Allocation:** Migrations `0001`–`0013` are immutable. Agent 1 allocates all `0014+` migration numbers sequentially. **Alpha.2A requires zero migrations and zero new dependencies.**
4. **Parallel Development Prerequisites:**
   - Owner visual review and merge of **UI.1** (`feat/ui1-icon-system-polish`) into `main` so both agents share the same post-UI.1 baseline.
   - Until UI.1 merges, Agent 2 is already authorized to branch `feat/alpha2a-workspace-panel-shell` from `069c5511142139232b7ca48b0953dd41b4272a8d` within Alpha.2A boundaries.

---

## 6. Upcoming Parallel Assignments (Planning Only — Not Started)

- **Agent 1 — Alpha.1A (Bot & Conversation Management):** Persistent pin/unpin, sidebar ordering, search, multiple conversation navigation, provider-only sidebar labels, unread/task completion indicators, and preservation of all bot identities/names.
- **Agent 2 — Alpha.2A (Workspace Panel Foundation):** Preserve existing Overview functionality, establish Workspace Panel tab structure (`Overview`, `Files`, `Changes`, `Browser`, `Output`), active bot/task workspace context, validated workspace authorization boundaries, and shared panel state/preferences.

---

## 7. Alpha.0 Administrative Closure & Superseded PRs

- **Scoped Readiness:** Alpha.0 (`069c5511142139232b7ca48b0953dd41b4272a8d`) is accepted for **internal personal Codex Chat** (`APPIMAGE_EXTRACT_AND_RUN=1`). General distribution remains **BLOCKED** by `CU4-PKG-02` (Issue `#3`), and `openclaw` (`P1-OC-01`/`P1-OC-02`), `kimi-acp` (`P5-KIMI-01`), Native Codex MCP (`#2`), and non-Codex live inference remain gated.
- **Superseded Stacked PRs (`#6`–`#14`) Retirement Record (all closed after PR `#15` merge):**
  - Integrated as direct ancestors of `main` (`069c5511142139232b7ca48b0953dd41b4272a8d`): `#6` (`d6436c6`), `#7` (`94a71dc`), `#8` (`fcded26`), `#9` (`c65a621`), `#10` (`d13e686`), `#11` (`5d57c39`), `#13` (`0291693`), `#14` (`fec34fc`).
  - Reconciled by content rather than commit ancestry: `#12` (`d4d5dbd`, reconciled into Alpha.0B `6779ab3` with `README.md` / `docs/ROADMAP.md` status updates).
