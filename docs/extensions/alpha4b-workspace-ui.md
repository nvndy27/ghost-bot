# Alpha.4B Workspace UI review

Status **Implemented**, with focused Electron evidence below. Maintainer visual approval is pending.

## Source and ancestry

Worktree `~/Documents/Projects/ghost-bot-worktrees/ghost-bot-alpha4b`, branch `feat/alpha4b-workspace-ui`. Started at the required provisional Alpha.3A input `f6716739e5ba9897c9a77e4fd3d0a2096a436202`, retaining the CSP attachment and acknowledged-save corrections. Accepted main `bae63048978ea0188d784a4d53910f3fb31cd552` is an ancestor.

Reconciled Alpha.3C `5a8c69dc1b9a6d590273dcd05f0d54629127fb47` and the published shared token/contract checkpoint `85f4b7f2c486ece800a82e8dd7f9c450d7389647` by a history-preserving merge. The shared palette comes directly from Agent 1. No separate Workspace palette or shared primitive was created. The shared UI checkpoint remains provisional while Agent 1 completes Alpha.4A.

Agent 2 independently accepted Alpha.3C after verifying both exact Alpha.3 inputs are ancestors, its six-file documentation delta leaves production/tests/workflows unchanged, and its three reported hosted checks passed. Provider plans match Alpha.3B byte for byte. Historical package evidence remains attributed to its actual source SHA. No packages or accepted tests were rerun for that review. [Exact-SHA verdict](https://github.com/nvndy27/ghost-bot/pull/49#issuecomment-7225398102)

## Approved design identity

Located `/home/nguyenduy/Downloads/ghost-alpha4-design-handoff-v03.2.zip`, SHA-256 `85f495035c61f2387b215de983c09249baa6f69b3c3e9920c82d215410b6bd67`. All six internal checksum entries passed.

Read the prototype, extracted CSS and handoff contracts and inspected the three reference PNGs. The final V03.2 cascade governs the dimensions and colors. References stay local in `/tmp/ghost-alpha4-v03.2` and the maintainer's original archive.

| Reference | SHA-256 |
| --- | --- |
| DESIGN_HANDOFF.md | `0602fb387ef5eac5ca0975dd9f3ecf93233390dcaecdac8b301b7b1ce134af8a` |
| ghost-bot-v03.2.html | `349a8ee404aa32708ec714e018736fc10426e6f9245c705d99c69be069683fdc` |
| reference.css | `dfc8e3f4182ff485c4d59ab80142ca04217fb1f5fbdb6238345b75ecb3dbd2e6` |
| ghost-bot-v03.2.png | `9993a5d2752592adfe0160565bb821058732316ef795a948d97f89d59da15aab` |
| ghost-bot-v03.2-team.png | `2e6e23956e8f4dffdf46a855e28331c2d22b189a820be93a8ff7c93f47307032` |
| ghost-bot-v03.2-compact.png | `4e39071c1f592a243ffa602c6f435b709afed4d43bc18330019bf1911b40c77f` |

## Implemented production surfaces

- Shell has the 58px header, existing permitted Live Viewer action, neutral icon tabs and trailing section label. The label hides at 290px so all five 32px targets remain in one row at 220px. IDs, keyboard navigation, persistence, context keys and collapse callbacks are retained. Maximize expands into the center area and Escape restores focus. It does not overlay application dialogs.
- Files uses the approved side-by-side Explorer/Editor with a 145px Explorer, pointer/keyboard resizing and independent scrolling. Panels at or below 360px use an Explorer overlay which closes on selection and returns automatically when the panel widens. Users can explicitly collapse it. Existing search, previews, multi-file tabs, native grants, save/conflict state and external-change handling remain wired to production APIs.
- Personal Overview uses the project, current activity, Tools and collapsed runtime hierarchy. The static Live Computer illustration and sample quota are removed. Real routine, task and runtime information and the existing refresh/reconnect actions remain. Quota is temporarily retained inside collapsed runtime details pending Agent 1's Usage Center integration.
- Team Overview retains actual members, task counts, blocked/uncertain states, budget, concurrency and safety diagnostics. Counts use the approved three-column presentation. Existing production avatars remain.
- Changes retains branch/status, selected diffs, commit history, refresh and cancellation. The presentation uses restrained rows and diff colors. Stage, unstage and revert remain visibly disabled with their existing explanation.
- Browser uses Lucide toolbar actions and the existing isolated WebContentsView. Bounds synchronize on resize/scroll and hide while visible semantic dialogs/menus/popovers are present. Overlay removal restores the native surface. Existing navigation, local network isolation, viewport controls, screenshots, console redaction and teardown remain.
- Output uses compact filter controls and flat log rows. Its existing execution state, cancel, refresh, clear/copy and scoped filtering remain. Personal Output still excludes private-task runs at the daemon boundary.

## Actual Electron visual evidence

Captures are under `design/reviews/alpha4b/` and use the built production renderer with an offline mock daemon and explicitly synthetic temporary files. They are actual app captures. The approved archive PNGs remain the visual baseline. Real state differs from the prototype's sample task, quota and repository data.

| View | Evidence |
| --- | --- |
| Overview, Dark and Light | [Dark](../../design/reviews/alpha4b/overview-dark-1440x900.png), [Light](../../design/reviews/alpha4b/overview-light-1440x900.png) |
| Files, Dark and Light | [Dark](../../design/reviews/alpha4b/files-dark-1440x900.png), [Light](../../design/reviews/alpha4b/files-light-1440x900.png) |
| Changes | [Dark](../../design/reviews/alpha4b/changes-dark-1440x900.png), [Light](../../design/reviews/alpha4b/changes-light-1440x900.png) |
| Browser | [Dark](../../design/reviews/alpha4b/browser-dark-1440x900.png), [Light](../../design/reviews/alpha4b/browser-light-1440x900.png) |
| Output | [Dark](../../design/reviews/alpha4b/output-dark-1440x900.png), [Light](../../design/reviews/alpha4b/output-light-1440x900.png) |
| Group Overview | [Dark](../../design/reviews/alpha4b/team-overview-dark-1440x900.png), [Light](../../design/reviews/alpha4b/team-overview-light-1440x900.png) |
| Other viewports | [1280×720](../../design/reviews/alpha4b/files-system-1280x720.png), [1920×1080](../../design/reviews/alpha4b/files-system-1920x1080.png) |
| Minimum width and overlay | [220px](../../design/reviews/alpha4b/files-minimum-220.png), [Explorer overlay](../../design/reviews/alpha4b/files-explorer-overlay-220.png) |
| Maximize | [Maximized Files](../../design/reviews/alpha4b/files-maximized.png) |

All five tabs also have System-theme captures. Separate 220px icon-row captures verify both themes. Screenshot review checked the 58px header, tab targets, horizontal split, truncation, toolbar wrapping and the full-width narrow editor. Maintainer visual approval remains required.

## Shared UI dependencies and remaining discrepancies

1. Agent 1 owns global App layout and persisted settings. Existing App/schema defaults remain 285px with a 420px resize cap. The reference specifies a new default of 400px and maximum 65 percent, plus narrower defaults and an overlay at 760px. Screenshots explicitly resize to the reference 400px. Coordinated App/settings bounds changes are still needed to apply those defaults without overwriting saved widths. No settings schema or migration changed in Alpha.4B.
2. Optional `RightPanel.onOpenTools` accepts the existing Tools & MCP settings action. Until App wires it, Connected tools remains disabled. Existing Terminal, Routines and Live Viewer callbacks work through their original APIs.
3. Agent 1's Usage Center should take canonical account usage/refresh ownership. The default Workspace Overview no longer duplicates quota. Collapsed runtime details retain actual quota and reconnect controls temporarily so existing access is preserved before the Usage Center lands.
4. The prototype has limited Browser, Output and diff examples. Those surfaces retain all real production controls and capability warnings while consuming its spacing and semantic tokens. Real task/member data and safety diagnostics can occupy more space than the illustrative reference.
5. Shared Sidebar/Chat/Settings and global compact/mobile layouts remain Agent 1-owned. These screenshots include their current production state and the shared palette checkpoint. They do not certify the completed Alpha.4A surfaces.

## Verification scope

Relevant source Electron regressions cover Shell/context/permission boundaries, native consent/save/watching/conflicts/revocation, discovery/preview/draft scope, read-only Git, Browser isolation/overlay occlusion and Output filtering/cancellation/restart. The added Alpha.4B scenario covers horizontal layout, pointer/keyboard Explorer resize, theme captures, min-width overlay, multi-file retention, maximize/restore and Group Files denial.

Tests use Electron 36.9.5, Node 24, Fedora desktop and the offline mock runtime. Development Electron uses the existing shared launch helper. Native preview sandbox preferences remain asserted. This is source-renderer evidence. Historical packaged sandbox evidence remains tied to `1071688`; no Alpha.4 package build, inference, migration or backend change occurred. Final package acceptance follows maintainer visual approval and RC freeze.

Final affected checks passed lint, desktop typechecks and desktop build, plus five Files/discovery/Git/Browser/Output scenarios and the Shell + Alpha.4B pair 2/2. The shell's old light-theme RGB assertion was updated to exact V03.2 `rgb(253, 253, 252)` after it caught the intended palette delta. Assertions for minimum-width targets, native consent, disk persistence, conflicts, revocation, network policy, private Output and cleanup remain. No full suite was run locally.

The final capture run passed 1/1 after adding explicit waits for loaded fixture bot state and the selected effective theme. This prevents resizing before persisted appearance loads and prevents a screenshot from carrying the previous palette. An interrupted capture process was cleaned up using its exact fixture process tree, then the focused capture passed. All 24 retained PNGs are actual Electron captures. Reference PNGs and the handoff archive were kept local.

Group Overview received a final hierarchy alignment with V03.2. Actual member status, task metrics and the current task stay visible. Per-member runtime/permission information, run status, blocked/uncertain counts, concurrency and usage remain accessible inside the expandable diagnostics. Safety/quarantine warnings remain visible independently. The focused capture/layout scenario passed 1/1 after this change, including explicit diagnostics expansion checks, and affected lint/typechecks and desktop build passed.
