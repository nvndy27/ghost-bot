# CU.2 — Isolated Browser Sandbox & Computer Use Hardening

**Branch:** `feat/computer-use-foundation`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-computer-use`  
**Package:** `@ghost-bot/computer-use` (`packages/computer-use/`)  
**Baseline:** `07839ff` (CU.1 HEAD: `b025d49`)

## 1. Confirmed CU.1 Findings & Fixes

1. **Concurrent Action Batches:** `ComputerUseActionController.executeBatch` now serializes batches per `sessionId` via `withSessionLock`, preventing interleaved pointer/keyboard calls on the same session.
2. **Mid-Flight Consent Revocation:** `executeBatch` re-checks `assertAuthorizedFor` immediately after an in-flight backend call returns and halts remaining actions if consent was revoked or emergency stop occurred mid-flight.
3. **Duplicate Action Identity & Payload Conflicts:** `seenActionsBySession` now stores SHA-256 payload hashes (`actionId -> hash`), rejecting both exact replays and conflicting payloads (`DUPLICATE_ACTION`).
4. **Observation Expiration:** Added `maxObservationAgeMs` (default `30000 ms`) and `DEFAULT_MAX_OBSERVATIONS_CACHED` (`200`) pruning in `ComputerUseActionController`.
5. **Emergency Stop Resource Cleanup:** Added `emergencyStopSession` to revoke session state, call `backend.cancelSession`, clear cached observations, and record an `emergency_stop` audit event.

## 2. Browser Capability Assessment

- **Playwright:** `playwright-core 1.65.1` present in workspace `node_modules`.
- **Browser Executable:** `/usr/bin/google-chrome` (`Google Chrome 157.0.8103.78`) available on host (Playwright's `chromium-1255` cache is absent).
- **Sandbox:** Sandboxed headless launch verified without `--no-sandbox`.

## 3. Browser Backend, Network Policy & Limitations

- `PlaywrightBrowserBackend` (`src/browser/playwright-browser-backend.ts`) creates a fresh `0700` temp `--user-data-dir` per session and an isolated `BrowserContext` (`acceptDownloads: false`, `permissions: []`, `serviceWorkers: 'block'`).
- `validateBrowserUrl` (`src/browser/network-policy.ts`) rejects `file:`, `chrome:`, `javascript:`, `data:`, `blob:`, `about:`, non-allowlisted `http:`/`https:` origins, and unauthorized `ws:`/`wss:` connections across `context.route('**/*', ...)`.
- Popups are closed automatically; downloads are cancelled; arbitrary `page.evaluate` JS execution is not exposed.
- **Network Isolation Limitation:** Playwright route interception + origin allowlists enforce application-layer origin control, but complete OS-level network isolation (e.g. preventing WebRTC/DNS side-channels) requires rootless container network namespaces (`podman --network=none` or dedicated proxy namespace) in future daemon/virtual-desktop integration.
