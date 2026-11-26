# Phase 3D.1 — Production Memory Integration

Date: 2026-11-26  
Branch: `feat/phase-3d1-memory-integration`  
Base checkpoint: `158a728` (Phase 3D.0)

## 1. Overview

Phase 3D.1 integrates `@ghost-bot/memory` into the daemon-owned Ghost Bot application (`apps/daemon`, `packages/shared-types`, `packages/runtime-adapters`, `apps/desktop`), delivering production SQLite persistence, trusted server-side authorization, authenticated IPC, a functional Memory Settings UI, and controlled execution-time context assembly.

## 2. Production Schema & Ownership (`0005_memory_core`)

- Added migration `0005_memory_core` in `apps/daemon/src/db/migrations.ts` and Drizzle definition in `apps/daemon/src/db/schema.ts`.
- Creates `memories` (with `bot_id REFERENCES agents(id) ON DELETE RESTRICT`, scope and status `CHECK` constraints, `idx_memories_active_dedup`, `idx_memories_scope`, `idx_memories_expires`) and `memories_fts` (`USING fts5(memory_id UNINDEXED, content, tags_text, tokenize='unicode61 remove_diacritics 2')`).
- Added `createBorrowedMemoryDatabaseHandle(sqlite, options)` in `packages/memory/src/storage/sqlite-client.ts` so `SqliteMemoryRepository` borrows the daemon's `DatabaseSync` connection without bypassing production migrations and without closing the daemon's connection when `MemoryService.close()` is called.

## 3. Daemon `MemoryService` & Authorization

- Implemented `MemoryService` (`apps/daemon/src/memory/service.ts`) owned by `GhostBotDaemon` (`apps/daemon/src/server.ts`).
- `MemoryAuthContext` (`actorId: 'daemon_memory'`, `userId: 'local-user'`, `botId`, `workspaceId`, `allowUserWideRead`, `allowUserWideWrite`) is constructed exclusively inside the daemon from persisted `agents` / `sessions` ownership and canonicalized `realpath(workspace_path)` (`deriveWorkspaceId`). Renderer-supplied `userId` or authorization flags are rejected by strict Zod schemas.
- Soft-archiving/deleting a bot (`DELETE /bots/:id`) calls `memoryService.archiveMemoriesForBot(botId)` to archive bot-scoped memories while preserving user-wide memories.
- Logical deletion removes rows from `memories` and `memories_fts` inside a transaction; this does not claim forensic erasure from SQLite freelist pages, WAL, or filesystem snapshots.

## 4. Preferences, Consent & IPC

- Added `MemorySettingsSchema` to `AppSettingsSchema` (`packages/shared-types/ipc.ts`) with conservative defaults: `enabled: true`, `automaticRetrieval: false`, `includeUserWide: false`, `externalProviderConsent: false`.
- Added strict Zod v4 IPC channels (`ghost:memory:list`, `ghost:memory:search`, `ghost:memory:create`, `ghost:memory:update`, `ghost:memory:archive`, `ghost:memory:delete`) in `packages/shared-types/ipc.ts`, `apps/desktop/electron/preload.cts`, and `apps/desktop/electron/main.ts` (`isAuthorizedSender` + Bearer-authenticated daemon HTTP routes).
- Implemented `MemorySettingsSection` (`apps/desktop/src/components/MemorySettingsSection.tsx`) inside `SettingsModal.tsx` supporting preferences/consent toggles, scope selection (`bot`, `workspace`, `user`), IME-safe search, creation, inline edit, archive, and two-step delete confirmation.

## 5. Execution Context Assembly & Runtime Capability Matrix

`RunOrchestrator` (`apps/daemon/src/execution/orchestrator.ts`) invokes `memoryService.prepareExecutionContext()` at the dispatch boundary in `executeMockRun` and `executeCodexRun`:
- Re-checks `enabled`, `automaticRetrieval`, `externalProviderConsent` (required for non-mock runtimes), and runtime capability.
- Revalidates each candidate record via `repo.getById` immediately before `buildMemoryContext` (`maxRecords: 6`, `maxChars: 3000`, `maxBytes: 8192`).
- Records only bounded metadata (`status`, `mechanism`, `count`, `totalBytes`, `truncated`) in `run.started` events — never raw memory content — and preserves the original user message in `messages`.
- Manual retry re-evaluates current preferences, consent, and live memory records at dispatch time.

| Runtime | Memory Context Support | Mechanism / Notes |
|---|---|---|
| `mock` / `mock-offline` | Supported (Offline verified) | Deterministic mock dispatch + bounded `run.started` metadata |
| `codex` | Supported (Protocol-fixture verified; live inference not run) | Separate `turn/start.input` reference item (`AgentRequest.referenceContext`); `baseInstructions` untouched; requires `externalProviderConsent` |
| `openclaw` | Unsupported | Live execution gated in Phase 2E |
| `ollama` | Unsupported | Execution not wired in `RunOrchestrator`; stateless `/api/chat` has only `system`/`user` roles |

## 6. Prompt Injection & External Privacy Limitations

- All retrieved records are serialized inside `untrusted_memory_reference_data` (`authority: "none"`). Memory cannot alter `permissionMode`, `approvals`, `accountId`, or `workspacePath`.
- Structured JSON envelopes do not independently guarantee downstream LLM prompt-injection resistance.
- Once memory is sent to an external provider with user consent, local deletion cannot retroactively remove data retained by the provider; users should start a **New chat** to avoid reusing an existing provider-managed thread that already received earlier memory.

## 7. Review & Hardening Findings Fixed

1. **Zod v4 Partial Settings Patch Overwrite (`packages/shared-types/ipc.ts`)**: Replaced `MemorySettingsSchema.partial()` in `AppSettingsPatchSchema` with explicit optional `MemorySettingsPatchSchema` (without `.default(...)`) so patching a single memory preference preserves all other persisted memory preferences.
2. **Atomic Bot Deletion & Memory Archival (`apps/daemon/src/bots/repository.ts`, `apps/daemon/src/memory/service.ts`, `apps/daemon/src/server.ts`)**: Added `onArchiveBot` callback inside `BotRepository.deleteBot()`'s transaction invoking `memoryService.archiveMemoriesForBotInTx()`, ensuring bot archival and bot-scoped memory archival succeed or fail atomically while preserving user-wide and shared workspace memories.
3. **Dispatch-Time Cancellation & Update Gate (`apps/daemon/src/execution/orchestrator.ts`, `apps/daemon/src/memory/service.ts`)**: Added post-preparation `signal.aborted || this.stopping` guards in `executeMockRun` and `executeCodexRun` before runtime dispatch, and gated `MemoryService.updateMemory` when `memory.enabled === false` while keeping `archiveMemory` and `deleteMemory` available for cleanup.
4. **Desktop UI Async Race & IPC Pre-Bounds (`apps/desktop/src/components/MemorySettingsSection.tsx`, `apps/desktop/electron/main.ts`)**: Added `loadSeqRef` sequence guarding in `MemorySettingsSection` so stale async list/search results cannot overwrite newer scope/bot state, reset edit/delete confirmation state on scope/bot switch, and added `assertBoundedMemoryIpcPayload()` before Zod parsing in Electron main.

## 8. Synthetic Performance Measurement (250-Record Corpus)

Measured on an isolated SQLite database (`node:sqlite` + FTS5) with 250 active bot-scoped memories:
- `MemoryService.searchMemories`: `13.61 ms`
- `MemoryService.prepareExecutionContext` (search + per-record `getById` revalidation + `buildMemoryContext`): `7.14 ms` (`selectedCount: 6`, `totalBytes: 2628`).
- Limitation: synchronous `node:sqlite` search runs on the daemon event loop; bounded by `MEMORY_LIMITS` (`maxQueryLength`, `maxSearchLimit`, `maxContextBytes`). Phase 3D.2 Knowledge corpus indexing/chunking will require explicit candidate caps and/or bounded batching.
