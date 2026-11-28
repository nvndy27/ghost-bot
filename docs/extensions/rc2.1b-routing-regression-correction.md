# RC2.1B — Routing regression-evidence correction

Date: 2026-11-29

## Checkpoint

- Repository: `nvndy27/ghost-bot`
- Branch: `fix/rc2-real-world-usability`
- Base: `8af368687c44f94ae9a5e58da14eb2c0c0717f9d`
- Scope: restore discriminating mock model fixtures and assertions in Team Routing and Group Discussion tests after CA2 review.
- Production code, provider catalog, permissions, dependencies, migrations, frozen RC1 and `main` are unchanged.

## Coverage restored

`tests/alpha1b-member-routing.test.ts` uses the seeded inherited `mock-model`, a `codex-mock` high-effort team override, and an independent `gpt-6.2-mock` low-effort override in another team. It verifies the mock catalog supports each selection, inherited values, persistence across database reopen, team-local overrides, unchanged global bot configuration, compatible execution snapshots after override reset, and existing session/scope behavior.

`tests/alpha1c-group-discussion.test.ts` gives the two fixture bots distinct supported global mock selections and verifies both members' model and effort in both discussion rounds. A team-only `mock-model` override for one member affects that team's subsequent discussion while the other team's inherited selection and global bot configuration remain unchanged. Existing tool-event rejection, cancellation, and personal-session isolation checks remain present.

These IDs are selected from the existing explicit mock runtime catalog. No model is added or fabricated, and real-provider catalogs are untouched.

## Verification

```text
node --experimental-strip-types --test --test-concurrency=1 \
  tests/alpha1b-member-routing.test.ts \
  tests/alpha1c-group-discussion.test.ts
```

Result: **3/3 passed**. `git diff --check` passed. This is focused offline module evidence, not hosted CI, live inference, or Electron acceptance.

## Handoff

RC2.2 Real Workspace proceeds as a separate commit on the same RC2 branch. Keep native directory grants and existing daemon authorization authoritative. No permission expansion, migrations, package builds, or live inference are in scope.
