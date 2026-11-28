# RC2.1B — Runtime compatibility and CI stabilization

Date: 2026-11-28

## Checkpoint

- Repository: `nvndy27/ghost-bot`
- Branch: `fix/rc2-real-world-usability`
- Starting PR #54 SHA: `bef0372cd1bfa0d391f6dfad372bc56e7eaf7ac8`
- Scope: resolve the ten root offline test failures reported by hosted run `46143801415` without weakening provider, task, memory, knowledge, MCP, or workspace assertions.
- No changes to migrations, dependencies, lockfile, frozen RC1 source, or `main`.

## Failure classification and correction

| Failure | Classification | Correction |
| --- | --- | --- |
| `alpha1a-bot-conversation-management.test.ts:124` bot create 400 | Production mock-catalog compatibility regression | The explicit mock adapter exposed only `mock-model`, although previous mock UI configurations also used `gpt-6.2-mock` and `codex-mock`. Added those clearly labeled legacy demo models to the mock adapter's own catalog and made team routing reuse that one catalog. They remain unavailable in production runtime mode. |
| `alpha1b-member-routing.test.ts:42` expected `codex-mock`, got `mock-model` | Stale fixture expectation | The current seeded developer bot stores `mock-model`; updated inheritance expectations to the actual persisted default. |
| `alpha1c-group-discussion.test.ts:68` expected old model IDs | Stale fixture expectation | Discussion routing inherits the current seeded `mock-model`; updated the assertions without changing discussion or isolation coverage. |
| `alpha1e-task-summary-publishing.test.ts:159` unsupported `high` effort | Stale fixture configuration | `mock-model` reports only low/medium. The test now switches to supported `codex-mock`/high so it still exercises a valid routing change after delegation and verifies dispatch rejection. |
| `alpha2a-workspace-panel-shell.test.ts:81` Connection detail hidden after click | Electron synchronization issue | The E2E now waits for selected-bot readiness to settle before interacting with the native disclosure, then waits for `HTMLDetailsElement.open` and retains the visible Connection assertion. No sleep or visibility assertion was removed. |
| `phase-3d1-memory.test.ts:161` bot create 403 | Stale fixture runtime ID | The daemon's canonical mock adapter ID is `mock-offline`; updated the API fixture from the obsolete `mock` alias. |
| `phase-3d1-memory.test.ts:325` memory create 404 | Downstream fixture setup failure | The preceding bot creation used the obsolete runtime ID and produced no bot. Corrected the upstream fixture; memory creation and scope assertions remain unchanged. |
| `phase-3d2-knowledge.test.ts:176` format validation returned 404 | Downstream fixture setup failure | Both setup bots used the obsolete runtime alias, leaving the knowledge scope without a bot. Corrected those API fixtures; the unsupported-PDF format assertion remains unchanged. |
| `phase-3d3-hardening.test.ts:164` workspace bot create 400 | Production mock-catalog compatibility regression | Resolved by exposing the historical `gpt-6.2-mock` selection within explicit mock mode only. Workspace-mode MCP denial assertions remain intact. |
| `phase-3d3-mcp.test.ts:411` read-only bot create 400 | Production mock-catalog compatibility regression | Resolved by the same mock-only catalog correction. Read-only MCP authorization assertions remain intact. |

The production change does not accept arbitrary models, efforts, or runtime IDs. Real-provider catalogs remain adapter-owned and never receive mock entries. The explicit `mock-offline` mode still validates selected model, effort, and permission against its exact catalog. No authorization gate was relaxed.

## Verification

Serialized affected-suite run, matching the hosted runner's single-test concurrency:

```text
node --experimental-strip-types --test --test-timeout=120000 --test-concurrency=1 \
  tests/alpha1a-bot-conversation-management.test.ts \
  tests/alpha1b-member-routing.test.ts \
  tests/alpha1c-group-discussion.test.ts \
  tests/alpha1e-task-summary-publishing.test.ts \
  tests/alpha2a-workspace-panel-shell.test.ts \
  tests/phase-3d1-memory.test.ts \
  tests/phase-3d2-knowledge.test.ts \
  tests/phase-3d3-hardening.test.ts \
  tests/phase-3d3-mcp.test.ts \
  tests/rc2-provider-readiness.test.ts
```

Result: **31/31 passed**, including the actual Electron Workspace disclosure test and RC2.1 readiness tests. An exploratory concurrent run had two load-sensitive failures (Electron process exit and the existing MCP p95 threshold); the serialized run passed without changing those thresholds. The local host does not provide `xvfb-run`; CI's hosted run supplies its own Xvfb/DBus wrapper.

`pnpm lint`, recursive workspace typecheck, source build, and `git diff --check` passed. This is source/offline evidence, not live provider or packaged acceptance. New exact-head hosted checks and independent acceptance remain required.
