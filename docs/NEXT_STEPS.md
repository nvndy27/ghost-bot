# Next steps

Phase 1B (main workspace UI) is **Verified** and ready for visual review. Next milestone: **Phase 1C — Bot management and persistence**:

1. Implement SQLite with versioned migrations in `@ghost-bot/daemon` (`agents`, `teams`, `team_members`, `provider_accounts`, `model_profiles`, `sessions`, `messages`, `settings`, `usage_records`, `audit_logs` per `docs/DB_SCHEMA.md`).
2. Implement persistent Bot CRUD (create, rename, edit instructions, duplicate, delete with confirmation, provider/model/effort/permission/workspace configuration) over typed Zod-validated IPC.
3. Implement the full Ghost Avatar System editor (shape, color palette, eye style, rotation, randomize, live preview, sanitized custom SVG upload) and migrate temporary UI preferences from `localStorage` to SQLite.
4. Proceed to Phase 1D (13-section Settings & runtime bridge) after Phase 1C acceptance.

Start with [progress](PROGRESS.md), [DB schema](DB_SCHEMA.md), and [design system](DESIGN_SYSTEM.md).
