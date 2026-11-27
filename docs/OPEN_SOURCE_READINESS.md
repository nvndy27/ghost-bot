# Open-source readiness

## License and provenance

Original project code and documentation are dual-licensed MIT OR Apache-2.0
where the contributors have rights to grant both licenses. See [LICENSE](../LICENSE),
[LICENSE-MIT](../LICENSE-MIT), and [NOTICE](../NOTICE). Third-party materials
retain their own terms. Review historical contributions for authority to
dual-license; reference screenshots are excluded from the grant.

## Configured checks (results pending)

- CI: Ubuntu 22.04, Node 24, frozen pnpm install, lint, typecheck, build before
  root and workspace tests (which require bundled desktop/daemon/worker fixtures).
  The runner supplies Xvfb, an isolated D-Bus session, Weston and Bubblewrap;
  an actual unprivileged namespace probe must pass. Tests have bounded execution
  and cleanup, without disabling browser isolation or dropping test files.
  No live provider calls, secrets, signing or deployment intended.
- Initial CI run [45950009023](https://github.com/nvndy27/ghost-bot/actions/runs/45950009023):
  install, lint and typecheck passed; root tests reported errors and timed out,
  so remaining steps did not run. CodeQL run
  [45950009112](https://github.com/nvndy27/ghost-bot/actions/runs/45950009112)
  completed successfully.
- Second CI run [45953206448](https://github.com/nvndy27/ghost-bot/actions/runs/45953206448): prerequisites, install, lint, typecheck, build and all 145 root tests passed (0 failed, 0 skipped). Workspace computer-use CU.3 capability probe failed on Ubuntu before the containment assertions; other sandboxed browser E2E tests passed. The probe now includes the same read-only loader/config mounts and /lib symlink as the isolated execution path; failure diagnostics are retained. Workspace recursion uses --no-bail so unrelated suites also report results without suppressing failure. CodeQL run [45953206476](https://github.com/nvndy27/ghost-bot/actions/runs/45953206476) passed. Revised CI results are pending.
- CodeQL: JavaScript/TypeScript analysis; inspect Security alerts and setup
  prerequisites. Successful execution is not proof of absence of vulnerabilities.
- Dependabot: weekly npm and Actions updates; review update PRs and enable
  vulnerability alerts through repository settings if not already enabled.
- OpenSSF Scorecard: scheduled/default-branch workflow; results published to
  the public Scorecard service. A score is not a certification.
- SBOM: manually run the Dependency graph SBOM workflow from main, then download
  the SPDX JSON artifact. This exports GitHub's current default-branch dependency
  graph, not an immutable artifact-specific inventory. Confirm coverage against
  pnpm-lock.yaml and produce a separate package/binary SBOM before release.
  See https://docs.github.com/en/rest/dependency-graph/sboms.

## Outstanding before claiming compliance or releasing binaries

- Inspect first workflow runs and resolve failures; enable required GitHub
  settings (dependency graph, Dependabot alerts, private vulnerability reporting).
- Register OpenSSF Best Practices at https://www.bestpractices.dev/ with actual
  evidence; no Passing/Silver/Gold badge until earned.
- Inventory copyright and license information per file; implement REUSE metadata
  only after verifying provenance. No REUSE-compliant badge until the check passes.
- Inventory third-party dependency notices for packaged artifacts; validate
  screenshots and reference rights, inspect public history for credentials,
  personal data and proprietary material, and remediate any exposure.
- Adopt branch protection, reviewed updates, release signing and provenance
  after coordinating with current Alpha agents. Do not enable automatic merges.
- Confirm reproducible release testing and actual platform support. Public source
  visibility and passing CI do not replace the Alpha release gates.
