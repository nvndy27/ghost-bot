# CU.3 — OS Isolation, Virtual Desktop PoC & Final Computer Use Acceptance

**Branch:** `feat/computer-use-foundation` (frozen after CU.3 acceptance)  
**Worktree:** `/home/nguyenduy/Documents/Projects/ghost-bot-computer-use`  
**Package:** `@ghost-bot/computer-use` (`packages/computer-use/`)  
**Baseline:** `07839ff` (CU.1: `b025d49`, CU.2: `81ef49d`)

## 1. Confirmed CU.2 Finding & Fix

- **Playwright Default `--no-sandbox` Injection:** Probing `/proc/<pid>/cmdline` and `chrome://sandbox` revealed that `playwright-core 1.65.1` injects `--no-sandbox` by default unless `chromiumSandbox: true` is explicitly passed.
- **Fix:** Added `chromiumSandbox: true` and `--webrtc-ip-handling-policy=disable_non_proxied_udp` to `PlaywrightBrowserBackend.createSession`, plus guaranteed `tempProfileDir` cleanup on failed launch. Verified `HAS_NO_SANDBOX_FLAG: false` and `chrome://sandbox` reporting `Layer 1 Sandbox Namespace`, `PID namespaces Yes`, `Network namespaces Yes`, `Seccomp-BPF sandbox Yes`, `You are adequately sandboxed.`.

## 2. OS Isolation Architecture & Containment Evidence

- **Selected Architecture:** Unprivileged `bubblewrap 0.13.1` (`bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL`) implemented in `BubblewrapIsolationRunner` (`src/isolation/bwrap-isolation-worker.ts`).
- **Observed Containment Evidence:**
  - Authorized synthetic `/work/fixture.json` inside the private `0700` temp workspace was read (`authorized: true`).
  - Host synthetic canary in `/tmp` was inaccessible (`canaryReadable: false`).
  - Host synthetic TCP listener on `127.0.0.1:<port>` was unreachable (`hostReachable: false`).
  - `WAYLAND_DISPLAY`, `DISPLAY`, and host `$HOME` were unexposed (`wayland: null`, `display: null`, `home: "/work"`).

## 3. Virtual Desktop Proof of Concept

- **Backend:** `WestonHeadlessVirtualDesktop` (`src/backends/weston-virtual-desktop.ts`) implementing `VirtualDesktopBackend` (`src/contracts/virtual-desktop.ts`).
- **Observed PoC Result:** Weston `headless-backend.so` started an isolated Wayland socket in a private `0700` `XDG_RUNTIME_DIR` without touching host `wayland-0`, and terminated cleanly on `SIGTERM` with full directory cleanup.
- **Limitation / Blocker:** `grim` frame capture failed (`exit 1`) because Weston headless lacks `wlr-screencopy-unstable-v1`, and `wayvnc`/`Xvfb`/`cage` are not installed. `frameCaptureSupported` and `inputInjectionSupported` remain `false` (fail closed with `UNSUPPORTED_CAPABILITY`) until VNC/PipeWire frame consumption or a wlroots compositor (`cage`/`wayvnc`) is packaged.

## 4. Final Independent Verdicts

- **Simulated Computer Use Foundation (CU.1):** **PASS**
- **Isolated Browser Sandbox (CU.2 + `chromiumSandbox: true`):** **PASS** (verified against synthetic loopback HTTP server with Chrome `157.0.8103.78` and `playwright-core 1.65.1`)
- **OS Process/Filesystem/Network Containment (`BubblewrapIsolationRunner`):** **PASS** (verified unprivileged `bwrap --unshare-all` canary & listener denial)
- **Virtual Desktop (`WestonHeadlessVirtualDesktop`):** **CONDITIONAL PASS** (isolated compositor socket lifecycle verified; frame streaming and virtual-desktop input remain blocked on VNC/PipeWire consumer or `cage`/`wayvnc`/`Xvfb` packaging)
