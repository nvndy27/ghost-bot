# Ghost Bot

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

**Your AI team, in one local-first workspace.**

Ghost Bot is a desktop AI workspace for personal agents, multi-model collaboration and developer workflows. Connect supported AI runtimes using your own accounts, API keys or local models, organize bots with independent configurations, and keep conversations and project data under your control.

> **Development preview — targeting v0.1 Personal & Friends Alpha.** The application has a working Electron/daemon foundation and a verified Codex MVP. The complete Alpha is not yet released. The source repository is public; the application remains a development preview, not a stable or completed Alpha release.

[Roadmap](docs/ROADMAP.md) · [Development progress](docs/PROGRESS.md) · [Provider matrix](docs/PROVIDER_MATRIX.md) · [Known issues](docs/KNOWN_ISSUES.md)

## What Ghost Bot is building

- **Personal bots:** individual avatars, instructions, model/effort settings, persistent conversations, streaming, usage and permissions.
- **Group Bot:** a discussion-first space where different AI models exchange ideas, plan and delegate work.
- **Private Task Chat:** assigned bots execute work in their own task conversations and return summaries, evidence and blockers to the group.
- **Workspace Panel:** review and edit files, inspect Git changes, preview a running website and view execution output beside the chat.
- **Agent foundation:** scoped Memory, Knowledge, MCP, Skills, Routines and Computer Use, subject to runtime capabilities and acceptance gates.

Group collaboration and the new Workspace Panel are planned for the first personal/friends release, not features claimed to be complete today.

## Current development status

| Area | Status |
| --- | --- |
| Electron desktop, avatars, bot management, persisted sessions | Implemented and previously verified |
| Codex App Server chat, streaming, cancellation, approvals and resume | Live MVP previously verified |
| Additional provider adapters | Implemented / offline protocol-tested on stacked development branches; live integration and acceptance pending |
| Memory, Knowledge, MCP | Integrated and offline-tested; capabilities and consent vary by runtime |
| Teams, Routines, Computer Use, Scoped Terminal | Existing foundations and offline acceptance evidence; live execution remains gated where unverified |
| Group Bot, member model selection and visible Private Task Chat summaries | Planned — Alpha.1 |
| Files/Editor, Git Diff, Browser/Live Demo and Output | Planned — Alpha.2 |
| Full Personal & Friends Alpha release | Pending integrated acceptance — Alpha.3 |

The integrated offline release-candidate baseline is Alpha.0B (`integration/alpha0-native-chat-rc`, stacked on PRs #6–#14); stacked development work is not equivalent to a merged or publicly released build. Consult [progress](docs/PROGRESS.md) and [next steps](docs/NEXT_STEPS.md) for the latest accepted checkpoints.

## Providers and runtimes

| Runtime | Connection method | Evidence / limitations |
| --- | --- | --- |
| OpenAI Codex | Official Codex App Server, dedicated ChatGPT-authenticated profile | Previously live-verified on CLI 0.172.0 |
| OpenClaw | Local gateway, CLI-managed authentication | Metadata and offline protocol evidence; live execution gated |
| Anthropic Claude | Official Messages API, user API key | Offline-tested; billed execution requires opt-in and live acceptance |
| Google Gemini | Official Gemini API, user API key | Offline-tested; billed execution requires opt-in and live acceptance |
| Kimi Code | Official Kimi CLI / ACP | Offline-tested; live CLI interoperability pending |
| Ollama | Local runtime | Offline-tested; live local inference pending |
| LM Studio / llama.cpp | Local OpenAI-compatible server | Offline-tested; local servers required for live checks |
| OpenRouter | Official API, user API key | Offline-tested; billed execution gated |

Ghost Bot does not include AI subscription access or API credits. Use only supported authentication routes. Model discovery, tools, usage reporting and permission modes are capability-dependent; unavailable features stay disabled and unknown quota is never fabricated. See the [provider matrix](docs/PROVIDER_MATRIX.md) and individual [integration reports](docs/extensions/) for exact evidence.

## Getting started — development build

The source repository is public. There is not yet a public installer for the Personal & Friends Alpha.

### Prerequisites

- Linux x86_64 for the currently verified packaging path (Fedora; Ubuntu validation planned).
- Node.js 24 or newer, pnpm 10.34.9 (as pinned in `package.json`), and Git.
- A supported provider CLI, API credential or local inference server only if you intend to use that provider.
- A Secret Service-compatible keyring for supported credential storage on Linux.
- Native packaging dependencies where applicable; see the [release report](docs/PHASE2_RELEASE_REPORT.md).

Use a normal user account. Do not run Ghost Bot as root or disable Electron sandboxing.

### Build and run

From a checkout of the relevant development branch:

```bash
git clone https://github.com/nvndy27/ghost-bot.git
cd ghost-bot
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm --filter @ghost-bot/desktop exec electron .
```

For renderer development, `corepack pnpm dev` starts the Vite development server on loopback. The legacy `prototype/index.html` is an offline mock UI, not the actual desktop application.

Open Settings → Accounts & Providers to inspect available runtime capabilities and configure supported accounts. For the previously verified Codex route, the dedicated profile can be authenticated with the official device flow:

```bash
CODEX_HOME="$HOME/.config/ghost-bot/codex-profile" codex login --device-auth
```

This does not replace your usual Codex profile. Never commit credentials or copy browser session tokens. Live inference and billed tests require explicit consent.

### Offline checks

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm -r --if-present test
corepack pnpm build
```

See the [test plan](docs/TEST_PLAN.md) and [progress log](docs/PROGRESS.md) for checkpoint-specific Electron acceptance commands. Live provider checks are separate from default offline checks.

### Linux packaging

```bash
corepack pnpm package:appimage
corepack pnpm package:rpm
```

Artifacts are built locally under `apps/desktop/release/`. Earlier AppImage and RPM builds have been verified on Fedora, including extracted-package smoke launches. This does not certify a new checkout or the complete Alpha. See [release evidence](docs/PHASE2_RELEASE_REPORT.md) and [known issues](docs/KNOWN_ISSUES.md) for FUSE and RPM prerequisites. Packages are development builds, not signed public releases.

## Roadmap

The first release is intentionally limited to the existing native Chat foundation plus two feature areas: Group Bot and the right-hand Workspace Panel.

| Milestone | Goal |
| --- | --- |
| Alpha.0 | Native Chat foundation, provider integration and acceptance |
| Alpha.1 | Pin bots/groups, independent member models, group discussion, private task execution and summary publishing |
| Alpha.2 | Overview, mini IDE, Files, Git Changes, Browser/Live Demo and Output |
| Alpha.3 | Security, integration, packaging and personal/friends release acceptance |
| v0.2 | Separate Terminal Workspace with upper-left Chat/Terminal switch, CLI sessions, split panes and worktrees |
| v0.3 | Advanced collaboration, cross-agent handoff, verification and project memory |
| v0.4+ | Proactive Companion, optimization and optional remote capabilities |

No Ghost Bot account, paid plans, billing, central server or cloud compute is required for the first Alpha. See the [full roadmap](docs/ROADMAP.md) for existing technical phases, scope boundaries and acceptance criteria.

## Architecture

```text
apps/
  desktop/          Electron + React + Vite UI
  daemon/           Node.js execution, policy and SQLite persistence
packages/
  runtime-adapters/ Provider transports and runtime adapters
  shared-types/     Typed contracts and IPC validation
  avatar/           Bot avatar rendering
  memory/           Scoped memory
  knowledge/        Knowledge and retrieval
  mcp/              MCP integration
  teams/            Multi-agent coordination
  scheduler/        Routines and durable scheduling
  computer-use/     Isolated browser execution
docs/               Roadmap, design, security and integration evidence
scripts/            Probes and acceptance checks
prototype/          Historical offline mock UI
```

The renderer uses validated IPC; the daemon owns runtime authorization, sessions, execution and SQLite data. Provider access, workspace grants and approvals are enforced at execution boundaries. See [architecture](docs/ARCHITECTURE.md) and [security](docs/SECURITY.md).

## Development and contribution

The project is being developed for personal use and a small group of testers first. Fedora with GNOME and Ubuntu are initial validation targets; Windows support will be claimed only after platform-specific testing. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Stable distribution remains subject to release acceptance.

Coding agents and contributors should read [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), [roadmap](docs/ROADMAP.md), [progress](docs/PROGRESS.md) and [next steps](docs/NEXT_STEPS.md) before making changes. Use scoped branches/worktrees and reviewed PRs, preserve frozen migrations 0001–0013, and record actual test evidence.

## License and privacy

Ghost Bot's original project code and documentation are licensed under the [Apache License 2.0](LICENSE) (SPDX: `Apache-2.0`). See [NOTICE](NOTICE) for attribution and scope. Third-party material retains its own terms; reference screenshots under `design/references/` are not licensed by Ghost Bot and must not be redistributed without the applicable rights. The license does not grant rights to third-party trademarks or provider services. Dependency, asset-rights and secret/history review remain required before distributing release artifacts.

Local-first does not mean fully offline: external provider requests send necessary context to the selected service, subject to permissions and consent. Local models can be used where the runtime supports them. No central Ghost Bot service is required by the planned first release.
