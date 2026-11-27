# Computer Use Foundation (`@ghost-bot/computer-use`)

**Branch:** `feat/computer-use-foundation`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-computer-use`  
**Package:** `@ghost-bot/computer-use` (`packages/computer-use/`)  
**Baseline:** `07839ff`

## 1. Approved Roadmap & PRD Scope

Per `docs/ROADMAP.md` (Phase 5: *"browser sandbox and live virtual desktop"*) and `docs/PRD.md` (P0 *"Settings: ... Computer Use ... Unimplemented features labeled unavailable"*, P2 *"Isolated virtual desktop and Playwright browser, live screen viewer, browser session isolation, visible action log"*):

This foundation slice delivers the independent contracts, coordinate/action validation, session/consent state machine, deterministic simulated backend, action execution controller, audit log contracts, and future daemon integration contracts without modifying `apps/daemon/`, `apps/desktop/`, or any frozen Phase 3/4/5A branches.

## 2. Package Architecture

- `@ghost-bot/computer-use/contracts` (`src/contracts/types.ts`): `ComputerUseBackend`, `ComputerUseCapabilities`, `ComputerUseSession`, `CaptureRequest`, `ScreenshotMetadata`, `DisplayGeometry`, `CaptureRegion`, `PointerAction`, `KeyboardAction`, `ActionBatch`, `ActionResult`, `SessionPermissionScope`, `ConsentState`, `ActionAuditEvent`, `ComputerUseError`.
- `@ghost-bot/computer-use/daemon-contracts` (`src/contracts/daemon-integration.ts`): Narrow future integration contracts for `RuntimePolicyBroker`, `RunOrchestrator`, approval correlation, OS consent correlation, emergency stop, per-bot scope, and desktop settings.
- `@ghost-bot/computer-use/coordinates` (`src/validation/coordinates.ts`): Pure logical↔physical coordinate conversion, multi-monitor & negative-origin display geometry validation, capture-region bounds, and stale-observation rejection (`topologyVersion` check).
- `@ghost-bot/computer-use/actions` (`src/validation/actions.ts`): Bounded action schemas (`MAX_BATCH_ACTIONS = 25`, `MAX_TEXT_ENTRY_BYTES = 1024`, `MAX_WAIT_MS = 10000`, `MAX_SCROLL_DELTA = 5000`), strict key allowlist, duplicate `actionId` rejection.
- `@ghost-bot/computer-use/session` (`src/session/session-state-machine.ts`): `ComputerUseSessionManager` lifecycle (`unavailable`, `idle`, `consent_required`, `authorized`, `active`, `paused`, `revoking`, `revoked`, `expired`, `interrupted`, `failed`), capability-specific grants, display scope, expiration, revocation, and emergency stop.
- `@ghost-bot/computer-use/simulated` (`src/backends/simulated-backend.ts`): `SimulatedComputerUseBackend` (`isSimulation: true`, `nativeWaylandVerified: false`).
- `@ghost-bot/computer-use/controller` (`src/controller/action-controller.ts`): `ComputerUseActionController` enforcing scope, capability, freshness, duplicate prevention, and fail-closed halt on uncertain outcomes (`replayAllowed: false`).
- `@ghost-bot/computer-use/audit` (`src/audit/audit-log.ts`): `ComputerUseAuditLog` excluding raw screenshots, typed text, clipboard contents, and credentials.

## 3. Security, Consent & Privacy Boundaries

1. **Capability Separation:** `observe_screen` consent does not grant `pointer_control` or `keyboard_control`. Hotplugged displays are not auto-granted.
2. **Untrusted Data:** Screenshot contents, action `description` fields, and AI-generated action batches are treated as untrusted data, never authorization.
3. **Simulated vs. Native:** Simulated consent and `SimulatedComputerUseBackend` always carry `isSimulation: true` and cannot masquerade as OS authorization.
4. **No Auto-Replay on Uncertain Outcomes:** Timeouts, disconnects, or unconfirmed cancellations mark the action `uncertain` (`replayAllowed: false`) and halt subsequent actions in the batch.
5. **No Unverified Window Exclusion Claim:** Sensitive application exclusion is not claimed enforceable until a native backend provides authoritative window/app identity.
6. **Teams & Scheduler Isolation:** Teams and scheduled routines must not inherit interactive Computer Use consent from Chief of Staff or prior user sessions.

## 4. Native Backend Strategy & Authorization Required

- **Recommended Native Path:** Prefer `org.freedesktop.portal.ScreenCast` (v5) + `org.freedesktop.portal.RemoteDesktop` (v2) with PipeWire (`1.6.11`) over unprivileged CLI tools, or an isolated virtual desktop / Playwright sandbox for unattended runs.
- **Additional Human Authorization Needed for Native Verification:** Explicit authorization to run an interactive portal consent test on a live Wayland session (GNOME or Hyprland), start a temporary PipeWire consumer, and verify single-action pointer/keyboard cancellation.
