# Product requirements — ghost-bot

## Vision
A local-first personal AI workspace with persistent agents, independently configurable personalities, model/account selection, collaboration, tools and autonomous routines. Reuse eligible subscriptions rather than paying API fees for all actions; local models are first-class. Target individual power users and developers first.

## P0 / v0.1
- Agent CRUD: name, description, avatar (shape, eyes, color, rotation or custom image), instructions, runtime, model, effort, workspace and permission defaults. Archive/delete with confirmation.
- Three-panel desktop: bot list/search, conversations, contextual workspace. Resizable/collapsible sidebars, theme, font and density.
- Provider/account settings: supported auth flow, connection status, discovery, disconnect, runtime diagnostics. Initial goal Codex subscription + OpenClaw Gateway and local Ollama after verification. API accounts opt-in only. No assumed Claude/Gemini/Kimi entitlements.
- Chat: streaming Markdown (sanitized), attachments scoped to workspace, cancellation, retry with new run, history, provider errors, tool status, real approval requests and usage metadata. Persist messages and run events. Changing runtime starts or bridges a new session with explicit history summary.
- Composer: model and effort dynamically derived from capabilities; permission selector (Read Only, Ask Approval, Workspace Access, Full Access). Unsupported mode disabled and explained. Account override per session.
- Usage: provider quota snapshots, local token counts, per-bot/run breakdown and API costs when known. Missing values visibly unknown; no invented subscription percentages. Show source and last refresh.
- Settings: General, Appearance, Accounts & Providers, Models, Usage, Personalization, Memory, Tools & MCP, Permissions, Computer Use, Routines, Data & Privacy, Advanced. Unimplemented features labeled unavailable.
- Ghost Avatar System: original procedural SVGs, presets, randomize, custom upload (validate/re-encode), reduced-motion support; idle/thinking/working/approval/success/sleep/error visual states.

## P1 / core expansion
Persistent memory with user review, edit/delete and per-agent/shared scopes; MCP and skills with consent and scoped tool grants; terminal and diff/patch viewer; teams and Chief of Staff task delegation with bounded concurrency and budget; durable routines (cron, file/webhook/event triggers) with history, notifications and restart recovery. Agent-to-agent messages preserve author and originating task. No implicit sharing of private memory.

## P2 / advanced
Isolated virtual desktop and Playwright browser, live screen viewer, browser session isolation, visible action log; consented meeting assistant (calendar join when supported, recording notice, transcript, summary); remote access and mobile companion; bot/skill marketplace, cross-platform packaging. Not a P0 requirement.

## User flows
Onboarding → local storage choice → connect supported account or Ollama → create bot → avatar and role → model/effort → permissions → chat. Approval: show tool, target, diff/command, risk and scope → allow once/deny (optional scoped remembered grant) → revalidate → execute → audit. Routine: choose bot/task/trigger/timezone/model/permissions/budget → review → enable → inspect runs/disable. Team: create team → select members/lead → assign tasks → review results.

## Non-goals
No reverse-engineered consumer web endpoints, cookie extraction, credential sharing, unauthorized subscription resale, unlimited autonomy, full office suite or cloud sync in v0.1. No copying third-party graphics into the released app.

## Success criteria
Persist bot and chat after restart; real provider streaming with cancellation; denied action produces no side effect; model/effort matches verified provider capability; unavailable quota stays unknown; clean offline UI; reproducible Linux package and documented security limitations.
