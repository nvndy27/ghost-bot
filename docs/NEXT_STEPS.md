# Next steps

Phase 1A (desktop scaffold) is **Verified**. Proceed to **Phase 1B — Main workspace UI** after acceptance review:

1. Implement the three-panel desktop layout in `apps/desktop/src/` matching `design/references/workspace-dark.png` and `prototype/` (left sidebar with search, bot list, animated SVG avatars, create bot button, teams, settings; center workspace with header, message stream, tool/approval cards, bottom composer with model/effort/permission selectors and send/stop; right sidebar with live workspace placeholder, active tasks, routines, connected tools, account usage).
2. Support Light, Dark, and System themes using `design/tokens.json`, resizable/collapsible sidebars, keyboard navigation, and `prefers-reduced-motion`.
3. Follow sequentially with Phase 1C (SQLite migrations, Bot CRUD, Ghost Avatar System) and Phase 1D (ChatGPT-inspired 13-section Settings & runtime bridge).

Start with [progress](PROGRESS.md), [design system](DESIGN_SYSTEM.md), and [DB schema](DB_SCHEMA.md).
