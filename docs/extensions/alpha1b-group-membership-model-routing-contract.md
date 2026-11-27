# Alpha.1B Group Membership and Model Routing

**Proposed.** Implementation requires maintainer approval of the shared baseline and this milestone.

## Existing boundaries

`TeamsService` validates active bot membership, keeps the lead in the canonical team roster, and synchronizes the legacy membership projection. Keep this ownership and the existing cap of 12. The current `TeamsExecutionBridge` revalidates membership and permissions, selects the daemon runtime mode, and reuses child sessions by bot and generated title. Live Teams execution is gated. `RuntimeRegistry` supplies provider capabilities and execution adapter generations. The orchestrator validates session/runtime compatibility and persists `runs.config_snapshot_json`.

## Membership and configuration

- Present 2–6 members as the normal configuration and preserve 7–12 as advanced. Keep existing single-member records usable. Use existing Teams commands and transactions to maintain unique active members, an active lead, and consistent legacy projections. Removing a member clears their scoped override in the same transaction. Require an explicit replacement when removing the lead.
- Model settings belong to the team-member binding. Store an optional explicit provider/runtime, account, model and effort override with a stable revision. Each unset field inherits from global settings when compatible. Changing provider/account must require explicit compatible selections wherever the inherited tuple is invalid. Reset removes the override. Never use team edits to write global bot settings.
- Resolve provider/runtime and eligible account using daemon-owned metadata, then validate model and effort against actual capabilities for that account. Distinguish inherited, explicitly selected, unavailable and unsupported choices. Saved but unavailable choices fail closed at dispatch. Do not invent accounts, model IDs, effort levels or provider fallbacks. The UI does not own credentials.
- Reuse existing tenant/team/member identity and validated IPC. Allocate a coordinated forward migration only if needed for durable bindings. Keep migrations 0001–0013 immutable.

## Dispatch and session identity

- Resolve and validate one effective tuple at the existing dispatch boundary. Recheck team membership, configuration revision, account and adapter availability/generation, permission ceilings and broker gates immediately before dispatch. Config changes during preparation fail closed or require explicit retry. Preserve live Teams and provider-specific gates.
- Freeze the effective team/member, provider/runtime, account, model, effort and configuration revision in the existing immutable run snapshot. Execution links use the same resolved facts. A later edit changes future dispatches. Approval, retries and cancellation retain the existing identity and idempotency rules. Revalidation can deny a snapshot after revocation.
- Reuse a child session only under matching team/run scope, member and provider-specific compatibility. Use durable identity instead of title lookup alone. A provider/account change or incompatible model change requires a fresh compatible session. Follow the adapter's existing rules for compatible model and effort changes. Keep old bindings and history intact. Never borrow a personal session or copy history silently.
- Verify isolated inheritance and overrides, member removal and re-add, legacy teams and limits, unsupported account/model/effort, immutable snapshots, restart and incompatible session reuse, with mock or offline fixtures.

Group discussion execution, Private Task Chat, automated summaries and any expansion of live execution remain outside Alpha.1B.
