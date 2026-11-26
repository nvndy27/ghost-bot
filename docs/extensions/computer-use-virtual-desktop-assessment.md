# Computer Use — Isolated Virtual Desktop Feasibility Assessment

**Probed Host:** Fedora Linux 45 (Workstation Edition)  
**Probe Method:** Read-only binary/version inspection (no privileged sessions or package installs performed).

## 1. Host Tooling Observed

- **Available:** `podman 6.2.0` (`/usr/bin/podman`), `bubblewrap 0.13.1` (`/usr/bin/bwrap`), `/usr/bin/Xwayland`, `/usr/bin/weston`.
- **Not installed:** `Xvfb`, `cage`, `labwc`, `wayvnc`, `gamescope`, `xpra`.

## 2. Recommended Architecture

For unattended or high-isolation browser/desktop runs (PRD P2 / Roadmap Phase 5), run applications inside a **rootless Podman container** (or `bubblewrap` sandbox) hosting an isolated headless compositor (`weston --backend=headless` or `Xvfb` once packaged) with:

1. **Dedicated Virtual Display:** Per-session compositor instance with no access to the host `WAYLAND_DISPLAY` (`wayland-0`) or host `HYPRLAND_INSTANCE_SIGNATURE`.
2. **Process & Filesystem Isolation:** Rootless container/user namespace with ephemeral `/tmp` profile, explicit canonical workspace bind mount (read-only by default), and zero access to `~/.config`, `~/.ssh`, or host browser profiles.
3. **Network Isolation:** Container `--network=none` or an explicit egress-filtering loopback proxy controlled by `apps/daemon`.
4. **Screen Streaming & Input Restriction:** Stream frames over an authenticated local Unix socket / VNC/PipeWire bridge scoped to the container's virtual display; inject pointer/keyboard events only into that virtual compositor.
5. **Resource Limits & Teardown:** Enforce `--cpus`, `--memory`, `--pids-limit`, and `podman rm -f` on emergency stop or session expiry.

## 3. Dependencies & Limitations

- Running a full virtual desktop requires either a pre-built rootless container image (with `weston`/`Xvfb` + `wayvnc`/`x11vnc` + Chromium) or installing `cage`/`wayvnc`/`Xvfb` via coordinated packaging.
- Direct host Wayland desktop control remains out of scope for unattended routines and requires explicit interactive portal consent.
