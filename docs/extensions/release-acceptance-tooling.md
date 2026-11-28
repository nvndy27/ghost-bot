# Alpha.3A release acceptance tooling

Status **In Progress**. This checkpoint prepares tooling only. It does not build packages, install host dependencies, or establish release readiness.

## Artifact upgrade and restart

Run from a normal user session on Linux after the final candidate package exists. Use two different executable AppImages or packaged Electron executables. For RPM, have the release operator install/extract the package on a disposable host and pass the resulting packaged executable. The harness refuses identical artifact checksums and refuses root execution.

```bash
node scripts/verify-release-upgrade.mjs \
  --previous /path/to/previous/GhostBot.AppImage \
  --candidate /path/to/candidate/GhostBot.AppImage \
  --source-sha <full-candidate-git-sha> \
  --evidence /path/to/release-evidence
```

The runner launches the previous artifact with a new mode-0700 synthetic profile, writes mock-only bot/avatar, personal conversation, group private-task, idempotency and Workspace preference fixtures through the real Electron bridge, and creates an unfinished mock run. It closes the previous app and waits for its daemon process to exit before snapshotting SQLite. It then launches the candidate with the same profile and checks identity, messages, private-task session separation, duplicate prevention, interrupted-run recovery, settings, exact migration-history prefix, preserved message contents and unrelated workspace canary. It closes the candidate and verifies daemon exit. The JSON result records the full operator-supplied candidate source SHA, both artifact SHA-256 values, platform, environment, per-check outcome and remaining limits. The runner does not infer binary provenance from a Git SHA. The temporary profile is removed after the report is written.

`--interactive-write-grant` adds an optional native-consent check. The operator must select the displayed temporary directory in the previous app's native read chooser and approve its native write prompt. After the candidate starts, the operator grants read access again for that same temporary directory. The runner verifies write access did not survive restart and that an unapproved create is denied. Declining or timing out fails that optional check. No grant is simulated or silently approved.

The runner uses mock mode and never starts live inference. It requires packaged mode, Chromium sandboxing, context isolation and disabled Node integration. It strips `ELECTRON_RUN_AS_NODE`, `ELECTRON_DISABLE_SANDBOX` and `NODE_OPTIONS` overrides from the child environment. Existing app security prompts remain enabled. Do not add `--no-sandbox` or a host profile path to these commands. An artifact pair failure is recorded as failed, not skipped.

## Linux prerequisite report

Run the checker on each provisioned acceptance host. It performs read-only filesystem and package queries and a short Bubblewrap user-namespace probe with `/` read-only. It does not install packages, mount FUSE, alter permissions or launch the packaged application.

```bash
node scripts/check-linux-release-prerequisites.mjs \
  > /path/to/release-evidence/linux-prerequisites.json
```

For a read-only inspection of an already available RPM's SHA-256, declared requirements and launcher paths, add `--rpm-artifact /path/to/existing.rpm`. This does not install or extract the package.

The report records Fedora RPM dependency package presence, optional RPM artifact checksum/requirements/launcher paths, installed RPM desktop launcher files, AppImage FUSE device/mount helper presence, Ubuntu/display environment, Chromium executable and root-owned SUID helper, Bubblewrap namespace behavior, and `/usr/bin/git`, `bwrap`, `prlimit`, `pdfinfo` and `pdftoppm`. It distinguishes presence probes from actual application acceptance. In particular, FUSE still requires a native launch of the exact AppImage, launcher acceptance requires the candidate RPM installed on a disposable Fedora host, and Ubuntu Wayland/X11/AppArmor checks require the actual target sessions. The report includes next actions for missing prerequisites; host owners provision them outside this checker.

## Release evidence record

Keep generated JSON outside source control until release evidence is reviewed and distribution policy is confirmed. For every run, preserve the candidate Git SHA, artifact hashes, OS release, desktop session, checker output, exact test logs and failed/unavailable capabilities. Never merge results from different SHAs or describe inherited package evidence as current-candidate verification. Package build and native package launch remain final-RC activities.

## Local validation in this tooling checkpoint

**Tested** — Both scripts pass Node syntax checks. The Linux prerequisite checker ran on Fedora 45, GNOME Wayland, x86_64. It found `/usr/bin/git`, Bubblewrap, `prlimit`, Poppler, Chrome and a root-owned mode-04755 Chrome sandbox helper; the read-only Bubblewrap namespace probe passed; FUSE device and `fusermount3` were present; the five explicitly declared Fedora RPM dependencies were installed. Read-only inspection of an existing RPM reported the same five runtime dependencies and launcher file paths. The Ghost Bot RPM and desktop launcher are not installed, so launcher acceptance remains open. This is environment inventory, not packaged release acceptance.

The only local package files available during this checkpoint are artifacts from prior evidence. No distinct previous/candidate package pair is available, so the full two-artifact upgrade runner was not executed. The same-artifact SHA refusal was exercised using `/usr/bin/true` twice; it exited before making an evidence directory. Ubuntu desktop, exact-candidate native FUSE, Fedora candidate launcher installation, grant-expiry UI interaction and final-source package verification remain unverified.

### Existing artifact inventory, not candidate acceptance

The package files currently present in `/home/nguyenduy/Documents/Projects/ghost-bot/apps/desktop/release/` hash to:

| Artifact | SHA-256 | Provenance |
|---|---|---|
| `GhostBot-0.1.0-x86_64.AppImage` | `b8d45e8b0eb4d232a20bef2cff47fd3dc88dc34bc8368b5df73083f3893faca8` | Historical local file; its build source SHA was not established here. |
| `ghost-bot-0.1.0-1.x86_64.rpm` | `24ba149303222cb8318905b4b16260969b5d6532e21018a4f6923e332103f9c6` | Historical local file; its build source SHA was not established here. |
| `ghost-bot-0.1.0.x86_64.rpm` | `08d4918a6b68408e39cff5de3e341f0b8fde1ccb68384ea41de40bab64a1be76` | Historical local file; its build source SHA was not established here. |

Read-only `rpm -qp --requires` on the first RPM reports `alsa-lib`, `gtk3`, `libXScrnSaver`, `libXtst` and `nss`, matching the native RPM spec. Its package file list includes `/usr/bin/ghost-bot`, `/opt/GhostBot/@ghost-botdesktop` and `/usr/share/applications/ghost-bot.desktop`. This inspects package metadata only. It does not prove successful installation, desktop launch or compatibility with the current source SHA.
