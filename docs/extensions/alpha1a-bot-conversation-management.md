# Alpha.1A Bot and Conversation Management

**State** — Tested on the post-UI.1 baseline `3ce8c3f6f7dcc925461010dab1ffa0f729562e00`. Submitted for draft review.

- My bots and Teams support persistent pins and within-section ordering, keyboard controls, and shared search. The daemon normalizes ordering against active records and prunes entries on deletion or archive.
- Bot rows show the original avatar, user-defined name, and provider derived from the persisted global runtime. Provider saves update the row on success. A provider-only edit preserves the existing workspace path, including legacy paths, while path changes still use existing validation.
- The conversation selector and manager use daemon sessions for create, select, rename and safe archive. The selected conversation persists per bot. The renderer loads successive session pages with stable ordering. Background runs keep their original bot and session IDs.
- Unread and completion derive from persisted personal conversation messages and runs. Explicit navigation and mark-read use the daemon read watermark. Existing settings storage holds pin/order and read state. No migration or dependency change.
- Private Task Chat and group task completion indicators await Alpha.1D. Runtime and provider execution gates remain in force.

## Offline evidence

Workspace lint, affected daemon/shared-types/desktop typechecks and desktop build passed. Focused tests passed 3/3, and database and Teams regressions passed 8/8. The two-launch Electron scenario verified all 12 presets, provider label updates and restart, bot pin/reorder/unpin, group pin via keyboard, search, create/rename/archive, active conversation restart, unread/read, background response routing, and deletion/archive cleanup. Dark and light screenshots are local. Zero live inference.
