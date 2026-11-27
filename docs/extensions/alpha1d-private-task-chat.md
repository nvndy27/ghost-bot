# Alpha.1D — Private Task Chat

- **Branch:** `feat/alpha1d-private-task-chat` (provisionally stacked on Alpha.1B PR #32 and Alpha.1C PR #34)
- **Migrations:** `0001`–`0014` preserved untouched (`0001`–`0013` immutable).
- **Routes / IPC:** `POST /teams/tasks/delegate`, `/teams/tasks/list-private`, `/teams/tasks/cancel-private` (`ghost:teams:tasks:*`)

## Implemented Scope
- **Explicit User-Approved Delegation:** `PrivateTaskChatService` validates active group membership, effective Alpha.1B member routing, and idempotent `operationId` before dispatching via `TeamsService` + `TeamsExecutionBridge` + `RunOrchestrator`.
- **Dedicated Private Task Chat Sessions:** Creates/reuses scoped team worker sessions (`SessionRepository.getOrCreateTeamSession`) keyed by `teamId + teamRunId + botId + routing + revision`, keeping personal conversations, group discussion, and task conversations strictly isolated.
- **Execution Lifecycle & Security Gates:** Supports queued/running/awaiting_approval/terminal states, task-specific cancellation, startup `uncertain` reconciliation without silent replay, and strict offline-mock gating (`LIVE_TEAMS_GATED` outside mock mode).
- **UI:** Discoverable `Delegate task` confirmation flow in `TeamDiscussionView`, `Private Tasks` sidebar navigation in `LeftSidebar`, and dedicated `PrivateTaskChatView` with bot identity, originating group, objective, routing badge, status, and cancel controls.
