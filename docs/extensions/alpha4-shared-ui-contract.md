# Alpha.4 shared UI contract — V03.2

## Source and checkpoint

The approved archive is `/home/nguyenduy/Downloads/ghost-alpha4-design-handoff-v03.2.zip`, SHA-256 `85f495035c61f2387b215de983c09249baa6f69b3c3e9920c82d215410b6bd67`. All six entries in SHA256SUMS passed. DESIGN_HANDOFF.md, the interactive HTML, reference.css and the three PNGs are the visual source. The final V03.2 optical alignment overrides take precedence over earlier CSS declarations.

This work starts at provisional Alpha.3C `5a8c69dc1b9a6d590273dcd05f0d54629127fb47`, Draft PR #49, containing exact PR #47 `f671673` and PR #48 `140b591`. Required CI, independent acceptance and maintainer approval still gate convergence. The actual production data, logo, all 12 BotAvatar presets and TeamAvatar modes remain authoritative.

## Canonical colors and theme

Use `apps/desktop/src/styles/tokens.css` and existing `:root[data-theme]` resolution. System follows the OS preference through existing App logic. Do not introduce a competing theme class or provider.

| Semantic token | Dark | Light |
|---|---|---|
| --gb-canvas / --gb-panel | #181818 | #fdfdfc |
| --gb-sidebar | #202020 | #f1f1ef |
| --gb-surface | #252525 | #ebebe9 |
| --gb-surface-hover / --gb-surface-active | #303030 | #e1e1df |
| --gb-border | #343434 | #d9d9d6 |
| --gb-text | #ebebeb | #242424 |
| --gb-muted | #a2a2a2 | #646464 |
| --gb-subtle | #818181 | #777777 |
| --gb-accent / --gb-success | #8cb69d | #417b5b |
| --gb-focus | #91add9 | #456dab |
| --gb-warning | #d8ab76 | #9c631f |
| --gb-danger | #dd9191 | #a94a4a |

Text must retain sufficient contrast for its actual size. Never encode error, selected or pending state solely by color. Preserve readable permission, stale, unavailable, approval and uncertainty notices.

## Typography and geometry

System UI sans-serif, body 14 px / 1.5. Small text 12 px, metadata 11 px. Use 500–600 weight for labels and headers. Spacing tokens are 4, 8, 12, 16 and 24 px. Existing radius tokens remain 6/10/14 px. Icon controls use 7 px radius, composer 14 px, settings dialog 13 px and upload/editor fields 7 px.

| Surface | Approved geometry |
|---|---|
| Sidebar | 224 px desktop, 190 px at <=1000 px, 56 px compact or <=760 px, explicit mobile expansion 190 px |
| Sidebar row | 46 px, 34 px avatar, compact 44 px row / 32 px avatar |
| Chat and Workspace header | 58 px |
| Chat content | Maximum 750 px, independent scrolling |
| Composer | Padding 11px 12px 8px, textarea 48–160 px, controls 34 px |
| Workspace | Default 400 px, minimum 220 px, maximum 65 percent, overlay at <=760 px |
| Explorer | Default 145 px, collapse/overlay at narrow sizes |
| Settings | Maximum 940 × 680 px, responsive viewport bounds |
| Create/edit dialog | Maximum 510 px with scrolling |

Existing persisted widths stay valid. New visual defaults must not overwrite user settings. Any change to persisted bounds needs coordinated schema and regression work. Agent 2 owns Workspace sizing implementation and responsive Explorer behavior.

## Icons and interaction states

Reuse installed Lucide React and `ICON_SIZE` 14/16/18/20 and `ICON_STROKE = 1.9` from IconButton.tsx. Reference SVG paths stay in the prototype. Standard icon buttons have 32 px targets, existing md targets remain 36 px and composer-specific controls use 34 px. The common glyph is 18 px. Preserve 32 px keyboard-accessible Workspace tab targets at minimum width.

Ghost idle uses muted text and transparent background. Hover uses the shared hover surface and text color. Selected uses the same neutral active surface with semantic aria-selected or aria-pressed. Focus-visible uses a 2 px focus outline. Disabled opacity is .45 with native disabled behavior. Busy actions retain their current truthful labels and cancellation availability. Respect reduced motion.

## Component contracts

Reuse the production primitives before adding new wrappers. No dependency or API replacement is required for this checkpoint.

- **IconButton** retains current props, including label, title, children, size sm/md, active, pressed, variant ghost/outline and native button/ref props. label provides the accessible name and default native tooltip. type defaults to button. Callers hide decorative glyphs from assistive technology. Agent 2 can consume the current API immediately.
- **Tooltip** initially uses the existing native title plus accessible button name. Supplementary custom tooltips, if necessary, must show on keyboard focus and pointer hover, support Escape, use role tooltip and aria-describedby, and contain no interactive actions. Tooltip text must never be the only accessible name or hide a required warning.
- **Popover** preserves existing conversation, mention and rounds popovers and Settings useModalDialog behavior. Triggers expose aria-expanded and aria-controls with stable IDs. Interactive content uses an appropriate labelled dialog/menu/listbox role, moves focus on open, closes on Escape and outside action, and restores trigger focus. Searchable member selection retains arrow-key/Enter behavior. Avoid a new generic API until a concrete production caller needs it.
- **Tabs** preserve WorkspacePanelShell controlled activeTab/onTabChange and WorkspaceTabId overview/files/changes/browser/output. Preserve tablist/tab/tabpanel roles, aria-selected, aria-controls, one tab stop and ArrowLeft/ArrowRight/Home/End navigation. Accessible names and title remain available for icon-only tabs. Reuse existing settings navigation as navigation buttons rather than imposing incompatible tab behavior.

## Shell and ownership boundaries

Agent 1 owns tokens, common components, shell/sidebar, Personal and Group Chat, Settings/Accounts and compact Provider Usage for this assignment. Agent 2 owns WorkspacePanelShell, RightPanel/TeamRightPanel presentation and components/workspace/** styles. The maintainer assignment supersedes the archive proposed ownership table.

Keep App callbacks, Workspace active tab persistence, selected bot/session/private-task context and existing native grants intact. Personal Workspace remains unavailable in Private Task Chat. Group membership grants no Files access. Existing layout integration passes width, onCollapse, activeTab, onTabChange and context through current props. No new IPC is required.

Workspace styling consumes semantic tokens. Agent 2 should not redefine root colors or change IconButton props. Agent 1 avoids Workspace-specific selectors and components. Shared changes are published as additive checkpoints and reconciled by history, without overwriting another worktree. The 400 px reference Workspace default exceeds the existing 420 px maximum only at later user resizing toward the reference 65 percent bound. Preserve existing bounds until coordinated implementation is ready.

## CSS and accessibility

Prefix production styles and tokens with gb-. Keep Workspace-specific selectors in existing workspace CSS modules/files. Never paste demo selectors such as .row, .sp, body.light or generic button overrides from reference.css. Preserve the existing theme and modal layers. Use min-width:0, truncation plus truthful titles, independent scroll and responsive viewport bounds for long real names.

All functional actions use native buttons or appropriate keyboard semantics with accessible names. Keep focus rings, Escape behavior, IME composition guards, auto-grow, reduced motion and live status feedback. Avatar artwork is never replaced with a generic Lucide glyph. Do not copy synthetic provider labels, quota values, messages, file contents or model choices. Missing provider/account enumeration is an explicit UI limitation until existing daemon data supports it.

## Validation and remaining work

Archive checksums and production component APIs were inspected. This early checkpoint publishes token values and reusable contracts before broad UI integration. Full visual acceptance remains pending actual Electron captures in both themes, compact/narrow layouts, Settings/Accounts/Usage and approval/error states. No backend, IPC, migration, package or permission change is part of this checkpoint.
