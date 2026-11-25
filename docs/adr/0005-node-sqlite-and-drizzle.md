# ADR 0005 — SQLite Persistence with `node:sqlite` and Drizzle ORM

Status: Accepted for Phase 1C.

## Context

Ghost Bot's daemon (`@ghost-bot/daemon`) runs under Electron 36's embedded Node (`ELECTRON_RUN_AS_NODE=1`, Node 22.19.0), while automated tests run under system Node 24.22.3. Native C++ SQLite addons (`better-sqlite3`) compile against a single Node ABI and break when switching between system Node and Electron without `electron-rebuild`.

## Decision

1. Use Node's built-in `node:sqlite` (`DatabaseSync`) — verified present in both Electron 36 (`v22.19.0`) and system Node (`v24.22.3`) — paired with `drizzle-orm/sqlite-core` and `drizzle-orm/sqlite-proxy`.
2. Store the database in a dedicated persistent directory (`GHOST_BOT_DATA_DIR` or `${XDG_DATA_HOME:-~/.local/share}/ghost-bot/ghost-bot.sqlite`) with `0700` directory permissions and `0600` database file permissions, completely separate from the temporary `0700` Unix socket runtime directory.
3. Enable `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`, and `PRAGMA busy_timeout = 5000` on every connection, and execute versioned SQL migrations inside `BEGIN IMMEDIATE` transactions tracked in `schema_migrations`.
4. Gate first-launch bot seeding behind the `seed.initial_bots.v1` settings key so deleted default bots are never recreated on restart.

## Consequences

- Zero native C++ build steps or ABI mismatches between Electron and system Node.
- All schema definitions, parameterized queries, foreign keys, and transactions remain compatible with Drizzle ORM and `docs/DB_SCHEMA.md`.
