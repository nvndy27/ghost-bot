# Alpha.2G Workspace convergence

## Scope and ancestry

The integration branch starts at PR #43 `4a469d4ac5e4b79c60226a1ac1fa98920135e0a3`. It contains #33, #35, #36 and #39 by ancestry. Main `815023b7dc134fe5fc4037ccf434db2ae3d34b1f` is already an ancestor. Its README and icon match the base stack. The separate branding proposal #38 is still open. Group integrity PR #42 is reviewed separately.

The integrated Workspace has Overview, Files, Changes, Browser and Output. Personal Files grants permit bounded text save and empty-file/folder creation. The existing quarantine, rename, non-empty creation, group writes, Ask Approval writes, and Git mutation restrictions remain enforced. Git inspection and PDF rasterization require the existing Bubblewrap isolation. Browser acceptance uses local HTTP fixtures.

## Local verification

On Fedora 45 with Node 24.22.3, Git 2.56.1, Bubblewrap 0.13.1 and Poppler 26.08.0, lint, recursive typecheck and build passed. The full offline root suite passed 178/178 with both sandboxes required and no skips. The recursive workspace suite passed 93/93. The root suite used the CI timeout, serial runner and D-Bus wrapper with the host graphical session. The hosted Ubuntu/Xvfb run is tracked on the integration draft.

The Electron scenarios exercise all five tabs, keyboard resizing, collapse, maximize, bot and team isolation, search and draft insertion, PDF rendering, native Files consent and revocation, dirty drafts, read-only Git refresh, Browser screenshot and preview destruction, and Output cancellation and restart recovery. Native dialog selections are controlled by the fixtures.

## Git index publication investigation

Git 2.56.1's lockfile API creates `index.lock` exclusively, writes the replacement, and renames it over the index. A disposable repository probe confirmed that an external `git add` fails while the lock is held and succeeds after release. A working-tree edit and `git update-ref HEAD` both succeeded while the same lock was held. The existing lock protocol coordinates Git index writers. It cannot stop same-user processes from replacing files outside that protocol and offers no joint precondition for the index, HEAD and working tree. [Git lockfile contract](https://github.com/git/git/blob/v2.56.1/lockfile.h), [update-index manual](https://git-scm.com/docs/git-update-index)

Stage would also need bounded object publication and a precisely approved content snapshot. Unstage would need a validated index revision and approved source tree. The existing inspection process operates on a private read-only copy. It provides no authority or safe transaction for publication to a real repository. Stage, unstage and revert stay gated on this integration.

## Executable Alpha.3 packaging acceptance

Build a local artifact from the candidate and run the harness on a Linux desktop or within the CI display and D-Bus wrappers. The host needs executable Git, Bubblewrap with nested user namespaces disabled, Poppler's `pdfinfo` and `pdftoppm`, and `prlimit` at the production paths under `/usr/bin`. Runtime availability is checked through the packaged daemon's offline mock runtime and provider catalog. An external provider's metadata or inference requires separate evidence.

```bash
node scripts/verify-alpha3-workspace.mjs apps/desktop/release/GhostBot-0.1.0-x86_64.AppImage
node scripts/verify-alpha3-workspace.mjs '/opt/GhostBot/@ghost-botdesktop'
```

The RPM check accepts the corresponding path in an extracted RPM payload when package installation is outside scope. AppImage mode exercises the exact artifact through extract-and-run. The harness prints the input executable hash and tool versions, uses transient test data and an isolated home, exercises the six real Workspace scenarios, and requires Chromium's sandbox for the packaged renderer and preview renderer. No live inference runs. A passing extracted RPM check does not establish installed desktop launcher behavior, and an extract-and-run check does not establish the FUSE launch path.

The CI job uses Ubuntu 24.04. Ubuntu 22.04 supplies Bubblewrap 0.6.1, which lacks the isolation flags required by Git and PDF preview. The configuration checks the exact flags and requires both sandbox-backed suites. [Ubuntu Bubblewrap versions](https://packages.ubuntu.com/bubblewrap), [Bubblewrap 0.9.0 source](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c)
