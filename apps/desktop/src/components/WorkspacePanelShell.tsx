import { Files, GitBranch, Globe, LayoutDashboard, Maximize2, Minimize2, Monitor, PanelRight, Terminal } from 'lucide-react'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { WorkspaceGitChanges } from './workspace/WorkspaceGitChanges.tsx'
import { WorkspaceBrowserTab } from './workspace/WorkspaceBrowserTab.tsx'
import { WorkspaceFilesTab } from './workspace/WorkspaceFilesTab.tsx'
import { WorkspaceOutputTab } from './workspace/WorkspaceOutputTab.tsx'
import type { WorkspaceDraftSelection } from './workspace/workspaceDiscoveryClient.ts'
import type { WorkspaceFilesTransport } from './workspace/workspaceFilesClient.ts'
import { WorkspacePlaceholderTab } from './workspace/WorkspacePlaceholderTab.tsx'
import {
  WORKSPACE_TABS,
  getNextWorkspaceTab,
  type WorkspaceTabId,
} from './workspace/workspaceTabs.ts'
import './workspace/workspace-shell.css'

const TAB_ICONS = {
  overview: LayoutDashboard,
  files: Files,
  changes: GitBranch,
  browser: Globe,
  output: Terminal,
} satisfies Record<WorkspaceTabId, typeof LayoutDashboard>

export interface WorkspacePanelShellProps {
  width: number
  contextKey: string
  contextLabel: string
  contextKind?: 'bot' | 'team'
  ownerId?: string | null
  workspacePath?: string | null
  isMockMode: boolean
  activeTab?: WorkspaceTabId
  onTabChange?: (tab: WorkspaceTabId) => void
  onOpenComputerUse?: () => void
  onCollapse: () => void
  overviewContent: ReactNode
  filesTransport?: WorkspaceFilesTransport | null
  onAddSelectionToDraft?: (selection: WorkspaceDraftSelection) => Promise<void>
}

export function WorkspacePanelShell({
  width,
  contextKey,
  contextLabel,
  contextKind = 'bot',
  ownerId = null,
  workspacePath,
  isMockMode,
  activeTab: controlledTab,
  onTabChange,
  onCollapse,
  onOpenComputerUse,
  overviewContent,
  filesTransport,
  onAddSelectionToDraft,
}: WorkspacePanelShellProps) {
  const [uncontrolledTab, setUncontrolledTab] = useState<WorkspaceTabId>('overview')
  const [maximized, setMaximized] = useState(false)
  const [filesMounted, setFilesMounted] = useState(false)
  const tabRefs = useRef<Partial<Record<WorkspaceTabId, HTMLButtonElement | null>>>({})
  const maximizeBtnRef = useRef<HTMLButtonElement | null>(null)
  const baseId = useId()

  // Reset local tab selection when switching bots or personal/group context so stale tabs never leak.
  useEffect(() => {
    if (controlledTab === undefined) {
      setUncontrolledTab('overview')
    }
  }, [contextKey, controlledTab])

  const activeTab = controlledTab ?? uncontrolledTab

  useEffect(() => {
    if (activeTab === 'files') {
      setFilesMounted(true)
    }
  }, [activeTab])

  const selectTab = (nextTab: WorkspaceTabId) => {
    if (controlledTab === undefined) {
      setUncontrolledTab(nextTab)
    }
    onTabChange?.(nextTab)
  }

  const handleTabKeyDown = (tabId: WorkspaceTabId, event: KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowRight' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    event.preventDefault()
    const nextTab = getNextWorkspaceTab(tabId, event.key)
    selectTab(nextTab)
    tabRefs.current[nextTab]?.focus()
  }

  const MaximizeIcon = maximized ? Minimize2 : Maximize2
  const title = 'Workspace'
  const activeTabDef = WORKSPACE_TABS.find((t) => t.id === activeTab) ?? WORKSPACE_TABS[0]

  const handleShellKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && maximized) {
      event.preventDefault()
      setMaximized(false)
      maximizeBtnRef.current?.focus()
    }
  }

  return (
    <aside
      className={`gb-right-panel gb-workspace-shell${maximized ? ' gb-workspace-shell--maximized' : ''}`}
      style={maximized ? undefined : { width: `${width}px` }}
      aria-label={contextKind === 'team' ? 'Team workspace panel' : 'Bot workspace panel'}
      data-testid="workspace-panel-shell"
      data-maximized={maximized ? 'true' : 'false'}
      data-active-tab={activeTab}
      onKeyDown={handleShellKeyDown}
    >
      <div className="gb-workspace-header">
        <div className="gb-workspace-title-group">
          <strong className="gb-workspace-title">{title}</strong>
        </div>
        <div className="gb-workspace-actions">
          <IconButton label="Open Live Viewer" onClick={onOpenComputerUse}
            disabled={!onOpenComputerUse}>
            <Monitor size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <button
            ref={maximizeBtnRef}
            type="button"
            className={maximized ? 'gb-icon-btn active' : 'gb-icon-btn'}
            onClick={() => setMaximized((prev) => !prev)}
            aria-pressed={maximized}
            aria-label={maximized ? 'Restore workspace panel' : 'Maximize workspace panel'}
            title={maximized ? 'Restore workspace panel' : 'Maximize workspace panel'}
            data-testid="workspace-maximize-btn"
          >
            <MaximizeIcon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </button>
          <IconButton
            label="Collapse workspace panel"
            onClick={onCollapse}
            data-testid="workspace-collapse-btn"
          >
            <PanelRight size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <div
        className="gb-workspace-tablist"
        role="tablist"
        aria-label="Workspace sections"
        aria-orientation="horizontal"
      >
        {WORKSPACE_TABS.map((tab) => {
          const TabIcon = TAB_ICONS[tab.id]
          const selected = tab.id === activeTab
          const tabHtmlId = `${baseId}-tab-${tab.id}`
          const panelHtmlId = `${baseId}-panel-${tab.id}`
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el
              }}
              id={tabHtmlId}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelHtmlId}
              tabIndex={selected ? 0 : -1}
              className={selected ? 'gb-icon-btn gb-workspace-tab active' : 'gb-icon-btn gb-workspace-tab'}
              aria-label={tab.shortLabel}
              title={tab.shortLabel}
              data-testid={`workspace-tab-${tab.id}`}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(tab.id, e)}
            >
              <TabIcon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </button>
          )
        })}
        <span className="gb-workspace-tab-label" aria-hidden="true">{activeTabDef.shortLabel}</span>
      </div>

      {activeTabDef.id !== 'files' && (
        <div
          id={`${baseId}-panel-${activeTabDef.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${activeTabDef.id}`}
          className="gb-workspace-tabpanel"
          data-testid={`workspace-tabpanel-${activeTabDef.id}`}
        >
          {activeTabDef.id === 'overview' ? (
            overviewContent
          ) : activeTabDef.id === 'changes' ? (
            <WorkspaceGitChanges key={contextKey} botId={contextKind === 'bot' ? ownerId : null} />
          ) : activeTabDef.id === 'browser' ? (
            <WorkspaceBrowserTab visible={activeTabDef.id === 'browser'} isMockMode={isMockMode} />
          ) : activeTabDef.id === 'output' ? (
            <WorkspaceOutputTab
              key={contextKey}
              contextKey={contextKey}
              contextKind={contextKind}
              ownerId={ownerId}
              isMockMode={isMockMode}
            />
          ) : (
            <WorkspacePlaceholderTab
              tab={activeTabDef}
              contextLabel={contextLabel}
              workspacePath={workspacePath}
              isMockMode={isMockMode}
            />
          )}
        </div>
      )}

      {filesMounted && (
        <div
          id={`${baseId}-panel-files`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-files`}
          className="gb-workspace-tabpanel"
          data-testid="workspace-tabpanel-files"
          hidden={activeTabDef.id !== 'files'}
        >
          <WorkspaceFilesTab
            contextKey={contextKey}
            contextKind={contextKind}
            ownerId={ownerId}
            contextLabel={contextLabel}
            workspacePath={workspacePath}
            isMockMode={isMockMode}
            transport={filesTransport}
            visible={activeTabDef.id === 'files'}
            onAddSelectionToDraft={onAddSelectionToDraft}
          />
        </div>
      )}
    </aside>
  )
}
