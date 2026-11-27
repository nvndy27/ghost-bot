# Computer Use — Final Production Integration Handoff

**Source Package:** `@ghost-bot/computer-use` (`feat/computer-use-foundation`)  
**Status:** Independent package & sandbox acceptance complete; production `apps/daemon` integration NOT STARTED.

## 1. Daemon Authority & Policy Wiring

- **`RuntimePolicyBroker` & `RunOrchestrator`:** All Computer Use sessions (`ComputerUseSessionManager`), browser sessions (`PlaywrightBrowserBackend`), and OS isolation workers (`BubblewrapIsolationRunner`) must be owned by `apps/daemon`.
- **Durable Approvals:** Every `observe_screen`, `pointer_control`, `keyboard_control`, and browser `allowNavigation` / `allowInteraction` capability must pass `RuntimePolicyBroker` and bind to a single-use `DaemonComputerUseApprovalCorrelation` (`runId`, `botId`, `capabilities`, `displayIds` or `allowedOrigins`, expiry).
- **Teams & Scheduler Boundary:** `inheritedFromTeamOrRoutine: false` is mandatory. Neither Chief of Staff, team workers, nor scheduled routines may inherit interactive desktop or browser consent.

## 2. Live Viewer, Action Ledger & Quarantine

- **Live Viewer (`LiveViewerStreamContract`):** Deliver bounded `LiveViewerFrame` metadata (`maxFrameBytes`, `maxDeliveryFps`, `backpressureDropCount`, `stale`, `emergencyStopSignaled`) over authenticated preload IPC without persisting raw screenshots by default.
- **Visible Action Ledger:** Persist `ActionAuditEvent` / `BrowserActionLedgerEntry` without raw typed text, cookies, tokens, or screenshot bytes.
- **Emergency Stop & Quarantine:** `emergencyStop` revokes consent, kills owned browser/container/Weston processes, cleans temporary directories, and marks any in-flight `uncertain` action `replayAllowed: false`.

## 3. Dependency & Packaging Reconciliation

- Reconcile `playwright-core` (`1.65.1`) and Chromium/Chrome executable discovery in `apps/daemon` during coordinated integration (never pass `--no-sandbox`).
- Keep unverified native Wayland host desktop capture/input and unverified virtual-desktop streaming **disabled by default** in Desktop Computer Use settings until native portal/PipeWire or container VNC consumers are implemented and verified.
