# Alpha.3 Linux packaging requirements for PDF previews

PDF previews are an optional capability. The current AppImage and RPM configurations package the Electron app and bundled daemon. They provide no packaged PDF rasterizer. The daemon uses the host tools at these fixed paths when the read-only workspace preview route is available.

| Runtime path | Purpose |
|---|---|
| `/usr/bin/bwrap` | Isolates the parser with a fresh mount layout and separate network, PID and user namespaces. Must support disabling nested user namespaces. |
| `/usr/bin/prlimit` | Applies address space, CPU, file size, descriptor and core dump limits inside the sandbox. |
| `/usr/bin/pdfinfo` and `/usr/bin/pdftoppm` | Poppler utilities for the page count and one static PNG page. Dynamic libraries use the host system library locations mounted read-only. System font and Poppler data mounts are optional. |

The feature is supported only for a non-root Linux process that can establish the required Bubblewrap isolation. The command needs no writable workspace mount, network or credential access. Missing paths, incompatible tools or denied namespaces make PDF preview unavailable. The package must keep that fail-closed path and must never fall back to direct host execution or an active PDF document in Electron.

## Release evidence required

- Validate the actual packaged daemon on each supported Linux artifact and host. Source-worktree success does not certify an AppImage or RPM. Record the executable paths, package owners and versions, effective namespace support, and rendered Markdown/static image/PDF capability separately.
- Test one packaged launch with the optional utilities present and valid isolation, one on an image with an absent utility, and one with the required namespace creation denied. Use temporary workspace fixtures and real native-grant IPC. Confirm the unavailable response does not affect existing read-only file browsing.
- If Alpha.3 chooses to distribute any runtime tools rather than treat them as host prerequisites, arrange a supported security-update path and review redistribution, notices and SBOM entries before adding them to the package. Current package metadata and this checkpoint leave them host-provided.
- Tested workspace-module reference only: Fedora 45 x86-64 with Bubblewrap 0.13.1, Poppler utilities 26.08.0 and prlimit from util-linux 2.42.4. These versions are evidence for the tested host. Minimum versions and other hosts have not been established.

Integrated Electron PDF preview still requires the shared native-grant route. No host packages were installed for this checkpoint.
