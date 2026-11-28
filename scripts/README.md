# Phase 0 probes

## Alpha.3 release acceptance tooling

- `node scripts/check-linux-release-prerequisites.mjs` prints read-only Linux host, Bubblewrap, Chromium sandbox, FUSE, Fedora RPM dependency/launcher, Ubuntu session and required-tool evidence as JSON. It does not install or download anything.
- `node scripts/verify-release-upgrade.mjs --previous <executable> --candidate <executable> --source-sha <full-git-sha> --evidence <directory>` runs same-profile upgrade/restart acceptance between two distinct Linux executable artifacts using mock execution and an isolated profile. Add `--interactive-write-grant` only on a desktop where an operator can grant and revoke native consent for the temporary synthetic workspace. It refuses identical artifact checksums and root execution. See [the complete procedure](../docs/extensions/release-acceptance-tooling.md).

Run from the repository root on Node 24 or later.

- `node scripts/probe-codex.mjs` starts the installed Codex CLI with a temporary profile and checks initialize, signed-out account state and one page of model/effort discovery. It never starts a turn.
- `node scripts/probe-openclaw.mjs` runs the installed OpenClaw CLI health RPC using CLI-managed auth. Requires a running configured gateway at `ws://127.0.0.1:18789`.
- `node scripts/probe-ollama.mjs` checks version and installed model count at `http://127.0.0.1:11434`. It never downloads or starts a model.

The probes are opt-in and exit nonzero when unavailable or when an expected response fails validation.
