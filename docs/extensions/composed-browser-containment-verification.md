# Composed Browser Containment Verification

**Branch:** `feat/browser-containment-verification`  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-browser-verification`  
**Base Checkpoint:** `d10df20` (`feat/integration-staging`)

## 1. Composed Architecture

`Computer Use Controller` → `BwrapIsolatedBrowserWorker` (`src/browser/bwrap-browser-worker.ts`) → `bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL` (with minimal `/etc` binds, private `0700` `/work`, `--tmpfs /tmp`, `--tmpfs /dev/shm`) → `PlaywrightBrowserBackend` (`chromiumSandbox: true`) → `Google Chrome 157.0.8103.78` (`Layer 1 Sandbox: Namespace + Seccomp-BPF`).

## 2. Minimal Host `/etc` Exposure

Replaced broad `--ro-bind /etc /etc` in `BubblewrapIsolationRunner` (`src/isolation/bwrap-isolation-worker.ts`) and `BwrapIsolatedBrowserWorker` with `getMinimalEtcBinds()` binding only `/etc/ld.so.cache`, `/etc/ld.so.conf`, `/etc/ld.so.conf.d`, `/etc/nsswitch.conf`, `/etc/ssl`, `/etc/pki`, `/etc/fonts`, `/etc/alternatives`, and `/etc/localtime` when present.

## 3. Observed Containment & E2E Evidence

- **Namespace Isolation:** `/proc/self/ns/{user,net,pid}` inside the worker differed from host namespaces.
- **Chromium Sandbox:** `hasNoSandboxFlag === false` for all launched Chrome sessions inside `bwrap`.
- **Filesystem Containment:** Host synthetic canary in `/tmp` was inaccessible (`canaryReadable: false`).
- **Network Containment:** Host synthetic `127.0.0.1` TCP listener was unreachable (`hostReachable: false`).
- **Desktop & Env Isolation:** `WAYLAND_DISPLAY: null`, `DISPLAY: null`, `DBUS_SESSION_BUS_ADDRESS: null`, `HOME: "/work"`.
- **Real Browser E2E inside `bwrap`:** Navigated to synthetic loopback fixture inside the isolated network namespace, captured PNG screenshot (`>100` bytes), typed `bwrap-isolated`, clicked `#btn`, verified `Submitted:bwrap-isolated`, verified session 2 had `cookie=none;ls=none`, and verified `emergencyStop()` terminated the worker and failed closed (`BACKEND_DISCONNECTED`) without unisolated fallback.

## 4. Packaging & Integration Limitations

- Packaged Electron (`apps/desktop`) runtime resolution of `BwrapIsolatedBrowserWorker` (`playwright-core` + `bwrap` + Chrome binary) is **not yet tested in a packaged AppImage/RPM**; production daemon integration remains deferred until Phase 3D.3 merges to `main`.
- Virtual desktop frame streaming and native Wayland host input remain disabled/unverified.
