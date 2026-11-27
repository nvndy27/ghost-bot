import { PanelRight } from 'lucide-react'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { WorkspaceFilesTab } from './workspace/WorkspaceFilesTab.tsx'
import type { WorkspaceFilesTransport } from './workspace/workspaceFilesClient.ts'
import { WorkspacePlaceholderTab } from './workspace/WorkspacePlaceholderTab.tsx'
import {
  WORKSPACE_TABS,
  getNextWorkspaceTab,
  type WorkspaceTabId,
} from './workspace/workspaceTabs.ts'
import './workspace/workspace-shell.css'

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
  onCollapse: () => void
  overviewContent: ReactNode
  filesTransport?: WorkspaceFilesTransport | null
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
  overviewContent,
  filesTransport,
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

  const title = contextKind === 'team' ? 'Team workspace' : 'Bot workspace'
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
          <button
            ref={maximizeBtnRef}
            type="button"
            className="gb-workspace-icon-btn"
            onClick={() => setMaximized((prev) => !prev)}
            aria-pressed={maximized}
            aria-label={maximized ? 'Restore workspace panel' : 'Maximize workspace panel'}
            title={maximized ? 'Restore workspace panel' : 'Maximize workspace panel'}
            data-testid="workspace-maximize-btn"
          >
            {maximized ? 'Restore' : 'Max'}
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
              className="gb-workspace-tab"
              data-testid={`workspace-tab-${tab.id}`}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(tab.id, e)}
            >
              {tab.shortLabel}
            </button>
          )
        })}
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
          />
        </div>
      )}
    </aside>
  )
}
