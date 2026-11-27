# Alpha.3A packaging readiness

Status **In Progress**. Accepted source baseline `bae63048978ea0188d784a4d53910f3fb31cd552` merged PR #46. Alpha.1 and Alpha.2 integration is accepted within its capability scope. This assignment adds a bounded CSP attachment wait to the shared packaged Electron harness. All existing sandbox, daemon health, mock-provider, renderer visibility and CSP content assertions remain in place.

## Evidence boundary

A2 accepted PR #46 at `c08c4a7344b03658f23d9d9a0b61bcbd5b1ea6f0`. Its CI and CodeQL passed. Package evidence is from `1071688c48afd7006476002be1d01e28662a0ab5` on Fedora, using AppImage extract-and-run and extracted RPM with Chromium sandboxing and offline mock runtime. AppImage SHA-256 `affab8e6f40dc3e7c5178abf1746e53f7fb5622e142bbd70eb51659588ce3429`. RPM SHA-256 `28e07c3ceede16284ba417fed6865b13bae28e878bfdb7524bfdfd7e79b631d4`.

The single main CI check during this assignment found CI and CodeQL in progress and Scorecard successful at `bae63048978ea0188d784a4d53910f3fb31cd552`. [CI run](https://github.com/nvndy27/ghost-bot/actions/runs/46045474681) · [CodeQL run](https://github.com/nvndy27/ghost-bot/actions/runs/46045474649)

No AppImage or RPM is built during Alpha.3A. Existing artifacts can verify the harness correction. Their source SHA remains the earlier integrated checkpoint.

## Inspected packaging and runtime contract

- `electron-builder.yml` includes the renderer, bundled main/preload and `dist-daemon` extra resources. The packaged main starts `resources/daemon/daemon.mjs` through its own Electron executable with `ELECTRON_RUN_AS_NODE=1`. End users do not need system Node for that daemon. Source acceptance scripts require Node 24 and frozen pnpm dependencies. Preserve embedded `node:sqlite` support when Electron changes.
- `bundle-daemon.mjs` includes the jsdom worker and Computer Use worker with vendored Playwright. External browser binaries and provider CLIs remain separately provisioned host dependencies. Missing tools must produce truthful unavailable states under the existing gates.
- Workspace inspection and PDF execution require `/usr/bin/git`, `/usr/bin/bwrap`, `/usr/bin/prlimit`, `/usr/bin/pdfinfo` and `/usr/bin/pdftoppm`. Presence alone does not prove namespace permission. The package harness exercises those paths with mandatory sandbox flags. Computer Use additionally needs a supported Chrome installation and its nested sandbox prerequisites. Hosted Jammy evidence is reusable for CI containment, while desktop Ubuntu policies require acceptance on the target host.
- Native `package:rpm` uses `build-rpm.mjs`, an `/usr/bin/ghost-bot` wrapper and a desktop entry invoking it. The script disables automatic RPM dependency discovery and declares GTK, NSS, ALSA, XScreenSaver and Xtst dependencies. Electron-builder's alternate RPM configuration has a different dependency list including libnotify. Minimal-host dependency completeness for either path remains **Blocked** pending the final clean-host package check. Do not infer completeness from the development workstation.
- Native RPM launcher passes user arguments and uses `/opt/GhostBot/@ghost-botdesktop`. Electron-builder supplies its own launcher with the configured Ozone hint. Check the final desktop entry, executable identity and Wayland/X11 launch on each target. No launcher defect was established from source inspection alone.
- AppImage extract-and-run bypasses the FUSE mount path. FUSE availability, sandbox helper ownership/mode and installed desktop integration must be checked with the actual final artifact. Preserve Chromium sandboxing and host namespace policy throughout acceptance.

## Final artifact acceptance after UI refinement

Run from a clean checkout of the approved final candidate. Record its exact SHA, dependency lockfile, distro, display session, package versions and full logs. Build once using the existing supported commands after build authorization. These commands are prepared for the later release operator.

```bash
set -euo pipefail
candidate=$(git rev-parse HEAD)
mkdir -p release-evidence
printf '%s\n' "$candidate" > release-evidence/source-sha.txt
cat /etc/os-release > release-evidence/os-release.txt
corepack pnpm install --frozen-lockfile
corepack pnpm package:appimage
corepack pnpm package:rpm
sha256sum apps/desktop/release/*.AppImage apps/desktop/release/*.rpm \
  > release-evidence/artifact-sha256.txt
rpm -qp --requires apps/desktop/release/ghost-bot-0.1.0-1.x86_64.rpm \
  > release-evidence/rpm-requires.txt
rpm -qp --scripts apps/desktop/release/ghost-bot-0.1.0-1.x86_64.rpm \
  > release-evidence/rpm-scripts.txt
rpm -qpl apps/desktop/release/ghost-bot-0.1.0-1.x86_64.rpm \
  > release-evidence/rpm-files.txt
dbus-run-session -- node scripts/verify-alpha3-workspace.mjs \
  "$PWD/apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage" \
  2>&1 | tee release-evidence/appimage-extract-and-run.log
```

Use actual artifact names if release versioning changes. The script's hash identifies the executable. Record the containing RPM hash separately for an installed or extracted RPM. On a provisioned Fedora acceptance VM, install the final RPM through the package manager with operator approval, then run the following as the ordinary desktop user. Installation is a separate authorized release step.

```bash
set -euo pipefail
rpm -V ghost-bot
cat /usr/share/applications/ghost-bot.desktop
command -v desktop-file-validate >/dev/null && \
  desktop-file-validate /usr/share/applications/ghost-bot.desktop
readlink -f /usr/bin/ghost-bot
cat /usr/bin/ghost-bot
dbus-run-session -- node scripts/verify-alpha3-workspace.mjs \
  /opt/GhostBot/@ghost-botdesktop 2>&1 | tee release-evidence/rpm-installed.log
acceptance_data=$(mktemp -d)
GHOST_BOT_RUNTIME_MODE=mock GHOST_BOT_DATA_DIR="$acceptance_data" /usr/bin/ghost-bot
GHOST_BOT_RUNTIME_MODE=mock GHOST_BOT_DATA_DIR="$acceptance_data" /usr/bin/ghost-bot
```

Close the first app normally before the second command. Use the isolated mock profile to verify persistence and absence of orphan daemon/preview processes on exit. Also launch the installed desktop entry from the GNOME app grid with a fresh mock profile. Record actual Exec, icon, application grouping and launch environment. A direct binary harness pass alone leaves the desktop launcher gap open.

For native FUSE acceptance on each target desktop, launch the final AppImage without extract-and-run, using a fresh mock profile. Preserve the logs when FUSE or namespace policy denies startup. Provisioning FUSE belongs to the acceptance host owner.

```bash
set -euo pipefail
fuse_data=$(mktemp -d)
env -u APPIMAGE_EXTRACT_AND_RUN -u APPIMAGE_EXTRACT \
  -u ELECTRON_DISABLE_SANDBOX -u ELECTRON_RUN_AS_NODE \
  GHOST_BOT_RUNTIME_MODE=mock GHOST_BOT_DATA_DIR="$fuse_data" \
  ./apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage \
  2>&1 | tee release-evidence/appimage-fuse.log
```

On Ubuntu desktop, repeat the AppImage harness and native FUSE steps on a provisioned target, including GNOME Wayland and X11 where claimed. Confirm namespaces work under its AppArmor policy. No Ubuntu-native package format is currently declared. Check missing Git, Poppler, Bubblewrap and provider CLI behavior in disposable VM snapshots, then restore prerequisites and rerun the affected scenario. Missing dependencies must remain visibly unavailable, with no unrestricted fallback.

## Upgrade and restart checklist

Status **Blocked** pending final packages and provisioned acceptance hosts.

1. Use a disposable profile with the previous accepted build. Create synthetic personal and group sessions, an avatar, private delegation and Workspace state with mock execution. Close all app processes before copying the complete profile, including SQLite WAL/SHM when present, as the backup. Record schema version and stable IDs with Node SQLite or an available SQLite client.
2. Install the final RPM upgrade on the disposable VM or switch to the final AppImage with that same profile. Record version and artifact hashes before and after. Check session content, avatar identity, routing, private-task isolation and Workspace state. Confirm migrations 0001–0014 and historical data survive without reseeding deleted bots.
3. Confirm native workspace grants expire across restart. Reauthorize explicitly for the scoped Files/PDF/Git checks. Verify unsupported Git mutations, Group filesystem access and existing provider/execution gates remain unavailable.
4. Close normally and relaunch with the same profile. Then repeat an interrupted-exit/restart fixture in a separate copied profile. Check truthful interrupted/uncertain outcomes and cancellation scope, with no duplicate delegation or automatic retry. Use only mock execution.
5. Treat application downgrade as unsupported until demonstrated. Restore the backup only with the application stopped and preserve the upgraded profile for diagnosis.

Final release acceptance requires recorded results for clean Fedora installation and launcher, native AppImage FUSE, Ubuntu desktop policy/runtime prerequisites, and upgrade/restart. Previous extracted-package evidence remains scoped to its source SHA. UI refinement and final build ownership are external dependencies of this readiness checkpoint.

## Alpha.3A checks actually executed

**Tested** — Lint and all recursive workspace typechecks passed. The single Browser Electron scenario passed 1/1 using the updated shared harness and the existing AppImage with SHA-256 `affab8e6f40dc3e7c5178abf1746e53f7fb5622e142bbd70eb51659588ce3429`. This specifically verifies the CSP readiness correction with all original assertions. Four documented Bash blocks passed `bash -n`, and `git diff --check` passed. No package build or installation ran. The complete accepted suites were reused.

Frozen dependency installation used ignored lifecycle scripts. The offline attempt lacked one pinned electron/node-gyp archive, then a frozen install retrieved it without lockfile changes. Recursive typechecking ran through `corepack pnpm -r --if-present typecheck` because the host has no standalone pnpm shim. Source installation requirements remain separate from installed-app runtime requirements.

## Targeted save regression — 2026-11-28

**Tested** — Main CI run `46045474681` subsequently failed the file-save Electron assertion with empty content. The test waited only for a disabled Save button. `WorkspaceFilesStore.saveTab` sets `saving` before awaiting IPC and the editor disables Save during that interval. The production save response follows atomic replacement, directory sync and descriptor/content verification. This failure was reproduced deterministically against the existing `1071688` AppImage by pausing its daemon before Save. The old predicate passed while the button displayed Saving and the file remained empty. The reproduction resumed the daemon in `finally`.

The test now requires both a disabled button and its idle Save label, the acknowledged clean state. Disk content is still checked immediately afterward. No sleep is added. A temporary gated reproduction verified the new predicate stayed false while the daemon was paused, then the complete affected scenario passed after resumption. The ordinary corrected scenario also passed, including native consent, empty create, persistence, external watching, dirty-buffer preservation, conflict and revocation. Temporary process-control instrumentation was removed. Production code and security gates are unchanged. [Main failure](https://github.com/nvndy27/ghost-bot/actions/runs/46045474681)
