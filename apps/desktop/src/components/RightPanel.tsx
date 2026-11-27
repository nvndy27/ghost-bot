import type { RoutineRecordDto, RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import {
  CalendarClock,
  Check,
  Activity,
  ChevronRight,
  Folder,
  Plug,
  Terminal,
} from 'lucide-react'
import type { ToolStep, WorkspaceBot } from '../types/workspace.ts'
import { ICON_STROKE } from './IconButton.tsx'
import { WorkspacePanelShell } from './WorkspacePanelShell.tsx'
import type { WorkspaceDraftSelection } from './workspace/workspaceDiscoveryClient.ts'
import type { WorkspaceFilesTransport } from './workspace/workspaceFilesClient.ts'
import type { WorkspaceTabId } from './workspace/workspaceTabs.ts'

export interface RightPanelProps {
  width: number
  bot: WorkspaceBot | null
  activeTasks: ToolStep[]
  runtimeSnapshot: RuntimeSnapshot | null
  isMockMode: boolean
  routines?: RoutineRecordDto[]
  unreadRoutineNotifications?: number
  activeTab?: WorkspaceTabId
  onTabChange?: (tab: WorkspaceTabId) => void
  filesTransport?: WorkspaceFilesTransport | null
  onAddSelectionToDraft?: (selection: WorkspaceDraftSelection) => Promise<void>
  onOpenRoutines?: () => void
  onOpenComputerUse?: () => void
  onOpenTools?: () => void
  onOpenTerminal?: () => void
  onReconnectRuntime?: () => void
  onCollapse: () => void
}

export function RightPanel({
  width,
  bot,
  activeTasks,
  runtimeSnapshot,
  isMockMode,
  routines,
  unreadRoutineNotifications = 0,
  activeTab,
  onTabChange,
  filesTransport,
  onAddSelectionToDraft,
  onOpenRoutines,
  onOpenComputerUse,
  onOpenTerminal,
  onOpenTools,
  onReconnectRuntime,
  onCollapse,
}: RightPanelProps) {
  const overviewContent = (
    <section className="gb-workspace-overview" aria-label="Workspace overview">
      <button type="button" className="gb-overview-summary" disabled={!bot?.workspacePath}
        onClick={() => onTabChange?.('files')}>
        <Folder size={20} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="gb-overview-summary-label">
          <strong>{bot?.workspacePath?.split('/').filter(Boolean).at(-1) || 'No workspace configured'}</strong>
          <small className="gb-muted" title={bot?.workspacePath}>Local workspace</small>
        </span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      <hr className="gb-divider" />
      <div className="gb-section-label">Current activity</div>
      {activeTasks.length === 0 ? <p className="gb-muted">No active tasks.</p> : activeTasks.map((task) => (
        <div className="gb-overview-activity" key={task.id}>
          {task.status === 'done' ? <Check size={16} aria-hidden="true" /> : <Activity size={16} aria-hidden="true" />}
          <span>{task.label}</span><small className="gb-muted">{task.status}</small>
        </div>
      ))}
      <hr className="gb-divider" />
      <div className="gb-section-label">Tools</div>
      <button type="button" className="gb-overview-summary" data-testid="open-scoped-terminal-btn"
        onClick={onOpenTerminal} disabled={!onOpenTerminal}>
        <Terminal size={18} aria-hidden="true" /><span>Scoped Terminal</span><ChevronRight size={16} aria-hidden="true" />
      </button>
      <button type="button" className="gb-overview-summary" onClick={onOpenTools} disabled={!onOpenTools}>
        <Plug size={18} aria-hidden="true" /><span>Connected tools</span><ChevronRight size={16} aria-hidden="true" />
      </button>
      <button type="button" className="gb-overview-summary" onClick={onOpenRoutines} disabled={!onOpenRoutines}>
        <CalendarClock size={18} aria-hidden="true" /><span>Routines</span>
        {unreadRoutineNotifications > 0 && <span className="gb-badge">{unreadRoutineNotifications} unread</span>}
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      {routines?.map((routine) => <div className="gb-overview-routine" key={routine.id}>
        <span>{routine.name}</span><small className="gb-muted">
          {routine.enabled ? (isMockMode ? 'Mock' : 'Gated') : 'Paused'} · {routine.nextRunAt ?? routine.timezone}
        </small>
      </div>)}
      <hr className="gb-divider" />
      <details className="gb-overview-runtime">
        <summary>Runtime details</summary>
        <p className="gb-muted">{runtimeSnapshot?.runtimeMode ?? (isMockMode ? 'Offline mock' : 'Unavailable')} · {bot?.statusLabel ?? 'No active bot'}</p>
        <p className="gb-muted">Connection: {runtimeSnapshot?.lifecycleState ?? runtimeSnapshot?.status ?? 'unavailable'}</p>
        {(!runtimeSnapshot || runtimeSnapshot.lifecycleState !== 'connected') && !isMockMode && onReconnectRuntime && (
            <button type="button" className="gb-btn-outline" onClick={onReconnectRuntime}>
              Reconnect runtime
            </button>
          )}
      </details>
    </section>
  )

  return (
    <WorkspacePanelShell
      width={width}
      contextKey={bot ? `bot:${bot.id}` : 'bot:none'}
      contextLabel={bot ? `${bot.name} (${bot.statusLabel})` : 'No active bot'}
      contextKind="bot"
      ownerId={bot?.id ?? null}
      workspacePath={bot?.workspacePath ?? null}
      isMockMode={isMockMode}
      activeTab={activeTab}
      onTabChange={onTabChange}
      onCollapse={onCollapse}
      onOpenComputerUse={onOpenComputerUse}
      overviewContent={overviewContent}
      filesTransport={filesTransport}
      onAddSelectionToDraft={onAddSelectionToDraft}
    />
  )
}
