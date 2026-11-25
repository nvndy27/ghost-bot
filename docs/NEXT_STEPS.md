# Next steps

Phase 1C (Bot management, SQLite persistence, and Avatar Editor) is **Verified** and ready for acceptance review. Next milestone: **Phase 1D — Settings and runtime bridge**:

1. Implement the 13-section ChatGPT-inspired Settings layout (`General`, `Appearance`, `Accounts & Providers`, `Models`, `Usage`, `Personalization`, `Memory`, `Tools & MCP`, `Permissions`, `Computer Use`, `Routines`, `Data & Privacy`, `Advanced`), keeping future-phase settings clearly marked as unavailable.
2. Wire `Accounts & Providers` and `Usage` to read real Codex App Server account status and rate-limit windows (`300m` / `10080m`, unknown values as unavailable) through the daemon without aggressive polling or modifying `~/.codex`.
3. Place `CodexAppServerAdapter` behind the daemon and policy broker alongside the explicitly labeled `MockRuntimeAdapter`, keeping `Full Access` disabled.

Start with [progress](PROGRESS.md), [DB schema](DB_SCHEMA.md), and [ADR 0005](adr/0005-node-sqlite-and-drizzle.md).
