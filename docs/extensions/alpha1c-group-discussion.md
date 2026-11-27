# Alpha.1C — Discussion-first Group Chat

- **Branch:** `feat/alpha1c-group-discussion` (stacked on Alpha.1B `feat/alpha1b-group-membership-model-routing` @ `cdf6c8e4d7c6eb66c72d0d8d204e344d4895b994`)
- **Migration:** `0014_team_discussion_turns` (`0001`–`0013` untouched)
- **Routes / IPC:** `POST /teams/discussion/list`, `/teams/discussion/send`, `/teams/discussion/cancel` (`ghost:teams:discussion:*`)

## Scope & Security Guarantees
- Offline mock-only group discussion (`TEAM_DISCUSSION_GATED` outside offline mock mode; live Teams remain gated).
- Explicit `@bot` / `@all` routing with active-membership validation and Alpha.1B effective member routing inheritance + revalidation.
- Strict tool-free execution (`read-only`, empty workspace/instructions, `TEAM_DISCUSSION_EVENT_REJECTED` on any tool/approval/artifact event).
- Bounded 1–2 round discussion/rebuttal, bounded concurrency (`<= 2`), duration cap, and shared character output budget (`DISC-01` atomic reservation).
- Safe sibling settlement on error (`DISC-02`), cancellation checks across async session creation and pre-commit persistence (`DISC-03`), and idempotency checking both prompt text and round count.
