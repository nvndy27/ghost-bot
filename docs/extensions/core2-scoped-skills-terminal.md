# Core.2: Scoped Skills & Secure Terminal Execution

- **Branch**: `feat/core2-scoped-skills-terminal` (branched from `def38d380c82b010582d3b46c945e06cabe0ef2a`)
- **Migration**: `0013_terminal_and_skills` (preserving `0001`–`0012` unchanged)
- **Live AI inference, external browsing, host desktop control, interactive PTY shells, and `sudo` remain disabled/unused.**

## 1. Command Runner Architecture & OS Containment
- Implemented daemon-owned `ScopedTerminalService` in `apps/daemon/src/terminal/service.ts`:
  - Uses direct `spawn('bwrap', [...], { detached: true })` with zero shell interpolation.
  - Enforces `--unshare-all` (user, net, pid, ipc, uts), `--die-with-parent`, `--new-session`, `--cap-drop ALL`, `--ro-bind /usr`, minimal `/etc` binds, `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, `--tmpfs /tmp-home`, `--tmpfs /dev/shm`, and `--bind <canonicalWorkspace> /workspace` + `--chdir /workspace`.
  - Uses `--clearenv` with minimal `PATH`, `HOME=/tmp-home`, `TMPDIR=/tmp`, `TERM=dumb`, `LC_ALL=C.UTF-8`; never mounts `$HOME`, OS keyring, D-Bus, Wayland/X11, container sockets, or provider/MCP credentials.
  - Interactive PTY shells remain disabled (`interactivePtySupported: false`, `hostUnisolatedFallbackAllowed: false`); fails closed if `bwrap` is unavailable (`TERMINAL_SANDBOX_UNAVAILABLE`).
  - Enforces bounded stdout/stderr (`256 KiB`, `truncated` flag, `redactSecrets`), `100ms..60s` timeout, and `MAX_CONCURRENT_COMMANDS = 2`.

## 2. Authorization, Approval & Process Lifecycle
- `requestCommandApproval` and `resolveCommandApproval` revalidate active unarchived bot, permission mode (`read-only` and `full-access` rejected), canonicalized `lstat`/`realpath` workspace (catching replacement races), active `running` daemon run, and unarchived parent chat session.
- Binds SHA-256 `commandHash` over `{ ownerId, botId, runId, canonicalWorkspace, executable, args, permissionMode, policyId: 'core2.bwrap.v1' }` and atomically consumes single-use approvals before spawn.
- Process-group `SIGTERM` + `SIGKILL` fallback terminates `bwrap` and descendants inside its PID namespace; unconfirmed termination preserves `status: 'uncertain'`, `terminationConfirmed: false`, `replayAllowed: false`.
- `reconcileOnStartup()` marks leftover `running` commands as `uncertain` and `awaiting_approval`/`queued` as `cancelled`, without replay.

## 3. Local Skills Registry
- Implemented `LocalSkillsService` in `apps/daemon/src/skills/service.ts`:
  - Read-only discovery of `SKILL.md` manifests inside canonicalized authorized root directories (`lstat` + `realpath`), rejecting traversal (`..`), symlinked `SKILL.md` (`SKILL_SYMLINK_REJECTED`), oversized (`> 64 KiB`), and malformed frontmatter.
  - Pins `trustedFingerprint` to SHA-256 `contentFingerprint` on `approveTrust`; re-discovery of modified content automatically sets `trustState = 'revoked'` and `enabled = false`.
  - Skill trust never grants terminal, MCP, credential, Computer Use, or network permissions, and never auto-injects into live model prompts.

## 4. Desktop Integration & Migration Compatibility
- Added `ScopedTerminalModal.tsx` (launched from `RightPanel` Connected tools `Open` button), `LocalSkillsSettingsSection.tsx` (in `SettingsModal` → Tools & MCP), daemon HTTP routes (`/terminal/*`, `/skills/*`), preload methods, and strict Zod IPC handlers in `apps/desktop/electron/main.ts` and `packages/shared-types/ipc.ts`.
- Migration `0013_terminal_and_skills` adds `terminal_commands` and `local_skills` cleanly while preserving `0001`–`0012` (`tests/db-persistence.test.ts`, `tests/execution-foundation.test.ts`, `tests/phase-3d3-mcp.test.ts`, `tests/phase-3d4-integrated.test.ts` updated for version `13`).

## 5. Verification Evidence (Post-Final-Edit)
- `corepack pnpm lint && corepack pnpm -r --if-present typecheck && corepack pnpm -r --if-present build`: **PASS** (11/11 projects).
- **3 consecutive full-workspace regression runs**: **213/213** per run (`root` 120, `@ghost-bot/teams` 20, `@ghost-bot/scheduler` 17, `@ghost-bot/computer-use` 16, `@ghost-bot/memory` 14, `@ghost-bot/knowledge` 12, `@ghost-bot/mcp` 14; 0 failed, 0 skipped).
- **Electron E2E & IPC scripts**: `verify-core1-credentials-desktop.mjs`, `verify-core2-terminal-skills-desktop.mjs`, `verify-cu4-computer-use-ipc.mjs`, `verify-cu5-computer-use-desktop.mjs`, `verify-phase-5b-scheduler-ipc.mjs`, `verify-phase-5c-routines-desktop.mjs`, `verify-phase-4d3-teams-acceptance.mjs`, `verify-phase-2e-acceptance.mjs`.
- **MCP concurrency stress (4 parallel workers)**: Verified next.
