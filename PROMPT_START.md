# Kickoff prompt — paste into Codex or Claude Code

You are the lead engineer for ghost-bot, a local-first multi-agent AI desktop application combining the persistent bot experience of Grok Bot with OpenClaw capabilities, official subscription-backed runtimes and local AI.

Read AGENTS.md, CLAUDE.md, README.md, docs/START_HERE.md, docs/PRD.md, docs/ARCHITECTURE.md, docs/ROADMAP.md, docs/SECURITY.md, docs/PROVIDER_MATRIX.md, docs/DESIGN_SYSTEM.md, docs/DB_SCHEMA.md, docs/PROTOCOL.md and docs/PROGRESS.md. Inspect both design/reference UI screenshots and run prototype/index.html. Preserve the visual design; the existing prototype is a reference, not the production architecture.

Target Fedora/Linux + Hyprland first; use Electron, React, TypeScript, Vite, Tailwind/shadcn, pnpm workspaces, Node daemon, SQLite/Drizzle, with OpenClaw Gateway and direct native runtime adapters behind a common interface. Keep app shell independent of runtimes. Do not assume every subscription offers an external API. Use supported official authentication and protocols; no cookie scraping, unauthorized proxy or account password handling. Do not use paid APIs without explicit user opt-in.

**Execute Phase 0 only.**
1. Inspect files and environment; record installed tool versions and any blockers. Do not install system packages or start paid requests without consent.
2. Research current official OpenClaw Gateway protocol, Codex App Server, Claude permitted integrations, Gemini subscription/API options, Kimi ACP and Ollama. Update the provider matrix with URLs, retrieval date, exact versions, capabilities, limitations and status.
3. Define canonical runtime ownership, normalized event/capability types and an approval state machine. Review existing TypeScript contracts and adjust only where evidence requires it. Plan for reconnect, cancellation, event ordering and unsupported capabilities.
4. Create small, opt-in real integration probes for OpenClaw and Codex (health/initialize, auth state, model discovery, quota if exposed). A local mock runtime must be separate. Do not claim a successful auth/run if not exercised. Add offline tests for normalization and permission denial.
5. Validate whether each runtime can enforce required permission modes, and document capability gaps. Keep sensitive actions separately approved. Document actual proof, errors and remaining questions.
6. Update roadmap, progress, ADR and security notes. Return a concise Phase 0 report with commands, test results, limitations, and proposed next slice.

Acceptance: protocol/auth evidence and probe results are reproducible; unsupported fields remain unknown; secrets are not stored in source; permissions fail closed; no unapproved network spending; blockers are explicit. Do not start Phase 1 until the Phase 0 gate is reviewed. If blocked on an account or installation, complete the offline work and specify the exact manual step required. Never fabricate a working integration.
