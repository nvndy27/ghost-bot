# Computer Use — Host Platform Capability Matrix

**Probed Host:** Fedora Linux 45 (Workstation Edition)  
**Active Session Observed:** `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=GNOME`, `WAYLAND_DISPLAY=wayland-0`  
**Probe Date:** 2026-11-26 (read-only metadata/DBus/package checks only; zero screen capture, consent dialogs, or input injection performed)

## Observed Package & Service Versions

- `xdg-desktop-portal`: `1.22.1-2.fc45.x86_64` (`active`)
- `xdg-desktop-portal-gnome`: `51.0-2.fc45.x86_64` (`active` in current GNOME Wayland session)
- `xdg-desktop-portal-hyprland`: `1.5.0-2.fc45.x86_64` (`inactive`; `HYPRLAND_INSTANCE_SIGNATURE` not set in current session)
- `hyprland`: `0.57.2-1.fc45.x86_64` (installed)
- `pipewire`: `1.6.11` (`pipewire` + `wireplumber` `active`)
- `org.freedesktop.portal.ScreenCast`: `version: 5`, `AvailableSourceTypes: 7` (Monitor | Window | Virtual), `AvailableCursorModes: 7` (Hidden | Embedded | Metadata)
- `org.freedesktop.portal.RemoteDesktop`: `version: 2`, `AvailableDeviceTypes: 7` (Keyboard | Pointer | Touchscreen)
- Installed Wayland CLI tools: `/usr/bin/grim`, `/usr/bin/slurp`, `/usr/bin/wl-copy`
- Not installed: `wtype`, `ydotool`, `dotool`

## Capability Matrix

| Capability / Interface | Status | Consent / Dependencies / Notes |
| --- | --- | --- |
| Session & Compositor Discovery (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`) | **Actually available on current host** | Confirmed `wayland` / `GNOME` (`wayland-0`). |
| `org.freedesktop.portal.ScreenCast` (v5) DBus Interface | **Documented, interface present, not runtime-verified** | Present on session bus; requires interactive user consent dialog + PipeWire frame consumer (`pipewire 1.6.11`) in a native worker. |
| `org.freedesktop.portal.RemoteDesktop` (v2) DBus Interface | **Documented, interface present, not runtime-verified** | Present on session bus (`AvailableDeviceTypes: 7`); requires explicit interactive user consent and compositor support; ScreenCast consent does NOT imply RemoteDesktop control. |
| `org.freedesktop.portal.Screenshot` | **Documented, interface present, not runtime-verified** | Present on session bus; requires user consent / portal request. |
| Hyprland IPC (`hyprctl monitors -j`) & `xdg-desktop-portal-hyprland` | **Installed, inactive in current session** | `hyprland-0.57.2` and `xdg-desktop-portal-hyprland-1.5.0` are installed, but current session is GNOME Wayland (`HYPRLAND_INSTANCE_SIGNATURE` unset). |
| PipeWire Video Stream Consumption | **Requires additional implementation / native binding** | `libpipewire 1.6.11` is present; Node/TypeScript daemon needs a small native/GStreamer/libpipewire helper or isolated sandboxed worker to read frames. |
| X11 Automation (`xdotool`, `XTest`) | **Unsupported on Wayland** | Never assume X11 automation works on Wayland sessions. |
| Unprivileged CLI Input (`wtype`, `ydotool`, `dotool`) | **Not installed / Not recommended as primary path** | Absent on host; `ydotool` requires `uinput` daemon privileges; prefer `org.freedesktop.portal.RemoteDesktop` for consented Wayland input. |
| Simulated Computer Use Backend (`@ghost-bot/computer-use`) | **Implemented & Tested (Simulation only)** | Explicit `isSimulation: true`; never interacts with host desktop. |
