# Open-source readiness

## License and provenance

Original project code and documentation are dual-licensed MIT OR Apache-2.0
where the contributors have rights to grant both licenses. See [LICENSE](../LICENSE),
[LICENSE-MIT](../LICENSE-MIT), and [NOTICE](../NOTICE). Third-party materials
retain their own terms. Review historical contributions for authority to
dual-license; reference screenshots are excluded from the grant.

## Configured checks (results pending)

- CI: Linux Node 24, frozen pnpm install, lint, typecheck, root and workspace
  tests, build. No live provider calls, secrets, signing or deployment intended.
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
