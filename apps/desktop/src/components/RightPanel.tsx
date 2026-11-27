import type { RoutineRecordDto, RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import {
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  Activity,
  ChevronRight,
  Folder,
  Plug,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import type { ToolStep, WorkspaceBot } from '../types/workspace.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
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
  onRefreshUsage?: () => void
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
  onRefreshUsage,
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
      <div>
        <div
          className="gb-section-label"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span className="gb-icon-inline">
            <ChartNoAxesColumn size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>Account usage</span>
          </span>
          {!isMockMode && onRefreshUsage && (
            <IconButton
              label="Refresh account usage"
              onClick={onRefreshUsage}
              style={{ width: 24, height: 24 }}
            >
              <RefreshCw size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          )}
        </div>
        {runtimeSnapshot && runtimeSnapshot.usageWindows.length > 0 ? (
          <div style={{ display: 'grid', gap: '8px' }}>
            <small className="gb-muted" style={{ fontSize: '11px' }}>
              Source: Provider subscription ({runtimeSnapshot.runtimeMode}
              {runtimeSnapshot.planType ? ` · ${runtimeSnapshot.planType}` : ''})
            </small>
            {runtimeSnapshot.usageWindows.map((w) => (
              <div key={w.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span className="gb-muted">Window {w.label}</span>
                  <span>
                    {w.usedPercent !== null
                      ? `${w.usedPercent}% used (${Math.max(0, 100 - w.usedPercent)}% left)`
                      : 'Unavailable'}
                  </span>
                </div>
                <div className="gb-bar" aria-hidden="true">
                  <div className="gb-bar-fill" style={{ width: `${w.usedPercent ?? 0}%` }} />
                </div>
                {w.resetAt && (
                  <small className="gb-muted" style={{ fontSize: '10.5px' }}>
                    Resets{' '}
                    {new Date(w.resetAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                )}
              </div>
            ))}
            <small className="gb-muted" style={{ fontSize: '11px' }}>
              Status: {runtimeSnapshot.status === 'stale' ? 'stale' : runtimeSnapshot.usageStatus}
              {runtimeSnapshot.usageObservedAt
                ? ` · Refreshed ${new Date(runtimeSnapshot.usageObservedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`
                : ''}
            </small>
            {runtimeSnapshot.lifecycleState &&
              runtimeSnapshot.lifecycleState !== 'connected' &&
              onReconnectRuntime && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  onClick={onReconnectRuntime}
                  style={{ fontSize: '11.5px', padding: '4px 8px' }}
                >
                  Reconnect runtime
                </button>
              )}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '6px' }}>
            <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
              {runtimeSnapshot
                ? `Usage ${runtimeSnapshot.usageStatus} (${runtimeSnapshot.lifecycleState ?? runtimeSnapshot.status})`
                : 'Usage unavailable.'}
            </p>
            {!isMockMode && onReconnectRuntime && (
              <button
                type="button"
                className="gb-btn-outline"
                onClick={onReconnectRuntime}
                style={{ fontSize: '11.5px', padding: '4px 8px' }}
              >
                Reconnect runtime
              </button>
            )}
          </div>
        )}
      </div>
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
