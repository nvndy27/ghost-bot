# ghost-bot — Starter Kit

Local-first, multi-agent AI desktop workspace inspired by the supplied Grok Bot-style layout and OpenClaw's runtime architecture. This archive contains a working **browser UI prototype**, original starter SVG avatars, a planning/specification kit, and TypeScript contracts. It is not yet a functioning agent client or an Electron release.

## Start here
1. Open `prototype/index.html` in Firefox/Chrome (no install, no network needed). Try switching bots, creating avatars, switching settings, model/effort/permission controls and mock approvals. All model names, quota and agent activity are demonstration data.
2. Read `docs/START_HERE.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md` and `docs/ROADMAP.md`.
3. Extract this folder, open it in VS Code, then start Codex or Claude Code in the root. Paste `PROMPT_START.md` into the coding agent. It should start with Phase 0 only.
4. Use `design/references/workspace-dark.png` and `settings-usage-dark.png` as the primary visual specifications. `grok-bot-inspiration.png` is contextual reference, not an asset to redistribute in the finished product.

## What's inside
- `AGENTS.md`, `CLAUDE.md`: agent rules; `PROMPT_START.md`: kickoff prompt.
- `docs/`: PRD, architecture, roadmap, provider matrix, security, data model, API/event contracts, design system, testing and ADR.
- `design/`: supplied screenshots, original SVG avatar presets and design tokens.
- `prototype/`: offline interactive demonstration; persists demo settings/bots in localStorage only.
- `packages/`: starter runtime contracts, avatar renderer; no real authentication or tools.
- `apps/`: reserved entry points for the implementation; no fake working backend.

## Fedora / Hyprland
For the future implementation, use a normal user account; install current supported Node LTS, pnpm, Git, optional Podman and a Secret Service-compatible keyring. Avoid root execution. Validate Wayland/Electron behavior and screen-sharing portals separately. The prototype needs only a browser.

## Status / boundaries
No provider credentials, subscriptions, live quota, real agent execution, automation or computer use have been connected or tested. Provider eligibility and official APIs must be verified in Phase 0. The source screenshots may include third-party material: keep them internal as references, not distributable production assets. Original SVG presets are distinct from third-party icon files. No third-party source code is vendored. A production project license has not been chosen.
