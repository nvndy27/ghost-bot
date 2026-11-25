# Progress log

## Phase 0 — Starter audit and runtime discovery

2026-11-25. Local baseline completed. Phase 0 exit review remains In Progress.

| State | Evidence |
|---|---|
| Verified | Audited starter files and three screenshots. Chrome headless loaded Chief of Staff, demo approval and offline composer. Preserved prototype behavior, design tokens and twelve SVG presets. |
| Verified | Initialized `main` and pushed starter commit `4af838c` to the authorized private repository. Configured repository-local author identity from the authenticated GitHub account using its noreply email. |
| Verified | Node 24.22.3, Codex 0.172.0 and OpenClaw CLI 2026.11.8 (2d4ab29). Codex isolated initialize, signed-out account status, and catalog of 11 models with 62 reasoning effort entries. OpenClaw loopback health returned `ok: true`. |
| Tested | `npm test` passed four offline tests. Strict TypeScript check and JavaScript syntax checks passed. |
| Implemented | Versioned event envelope and model discovery types in `packages/shared-types/`, preflight permission guard, three opt-in probes in `scripts/`, SQLite design and [ADR 0003](adr/0003-provider-probes-and-permissions.md). No SQLite persistence or desktop scaffold was started. |
| Blocked | Ollama binary absent and loopback port 11434 refused connections. Claude subscription integration requires vendor approval. |
| Not Started | Authenticated Codex quota and inference, native Gateway session handling, production permission enforcement, live Kimi ACP and Gemini integration. |

Provider sources and evidence limits are in [provider matrix](PROVIDER_MATRIX.md). Screenshots are excluded from Git because publication rights are unconfirmed. The source files remain locally under `design/references/`. Production license remains undecided.

The commit containing this entry records the Phase 0 runtime milestone. See `git log --oneline` and [next steps](NEXT_STEPS.md) for handoff.
