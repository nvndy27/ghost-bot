import type { RoutineRecordDto, RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import { MOCK_ROUTINES, MOCK_TOOLS } from '../data/mockWorkspace.ts'
import type { ToolStep, WorkspaceBot } from '../types/workspace.ts'
import { WorkspacePanelShell } from './WorkspacePanelShell.tsx'
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
  onOpenRoutines?: () => void
  onOpenComputerUse?: () => void
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
  onOpenRoutines,
  onOpenComputerUse,
  onOpenTerminal,
  onRefreshUsage,
  onReconnectRuntime,
  onCollapse,
}: RightPanelProps) {
  const overviewContent = (
    <>
      <div className="gb-screen-mock" aria-hidden="true">
        <div className="gb-screen-bar">
          <span>● ● ●</span>
          <span style={{ marginLeft: 'auto' }}>{bot?.workspacePath ?? 'No workspace'}</span>
        </div>
        <div className="gb-screen-body">
          <div className="gb-screen-side" />
          <div className="gb-screen-lines">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'center', marginTop: '8px' }}>
        <div>Live computer</div>
        <small className="gb-muted">
          {onOpenComputerUse
            ? 'Isolated browser · ready'
            : isMockMode
              ? 'Mock preview · unavailable'
              : 'Unavailable'}
        </small>
        {onOpenComputerUse && (
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              className="gb-btn-outline"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={onOpenComputerUse}
            >
              Open Live Viewer
            </button>
          </div>
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div className="gb-section-label">Active tasks</div>
        {activeTasks.length === 0 ? (
          <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
            No active tasks.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {activeTasks.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span aria-hidden="true">{t.status === 'done' ? '✓' : '✳'}</span>
                <span>{t.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div
          className="gb-section-label"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span>
            Routines
            {unreadRoutineNotifications > 0 && (
              <span className="gb-badge" style={{ marginLeft: 6 }}>
                {unreadRoutineNotifications} unread
              </span>
            )}
          </span>
          {onOpenRoutines && (
            <button
              type="button"
              className="gb-btn-outline"
              style={{ padding: '2px 7px', fontSize: 11 }}
              onClick={onOpenRoutines}
            >
              Manage
            </button>
          )}
        </div>
        {routines !== undefined ? (
          routines.length === 0 ? (
            <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
              No routines configured.
            </p>
          ) : (
            routines.slice(0, 4).map((rt) => (
              <div key={rt.id} style={{ marginBottom: '10px' }}>
                <div>
                  ◷ {rt.name}{' '}
                  <span className="gb-badge">
                    {rt.enabled ? (isMockMode ? 'Mock' : 'Gated') : 'Paused'}
                  </span>
                </div>
                <div className="gb-muted" style={{ paddingLeft: '18px', fontSize: '12px' }}>
                  {rt.nextRunAt ? `Next: ${rt.nextRunAt}` : `${rt.timezone} · ${String(rt.trigger.kind)}`}
                </div>
              </div>
            ))
          )
        ) : (
          MOCK_ROUTINES.map((rt) => (
            <div key={rt.id} style={{ marginBottom: '10px' }}>
              <div>
                ◷ {rt.name} <span className="gb-badge">Phase 5</span>
              </div>
              <div className="gb-muted" style={{ paddingLeft: '18px', fontSize: '12px' }}>
                {rt.schedule}
              </div>
            </div>
          ))
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div className="gb-section-label">Connected tools</div>
        {isMockMode ? (
          MOCK_TOOLS.map((tool) => (
            <div
              key={tool.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '6px',
              }}
            >
              <span>{tool.kind === 'terminal' && onOpenTerminal ? 'Scoped Terminal' : tool.name}</span>
              {tool.kind === 'terminal' && onOpenTerminal ? (
                <button
                  type="button"
                  className="gb-btn-outline"
                  data-testid="open-scoped-terminal-btn"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={onOpenTerminal}
                >
                  Open
                </button>
              ) : (
                <span className="gb-badge">{tool.note}</span>
              )}
            </div>
          ))
        ) : (
          <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
            Tool integrations unavailable (Phase 3).
          </p>
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div
          className="gb-section-label"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span>Account usage</span>
          {!isMockMode && onRefreshUsage && (
            <button
              type="button"
              onClick={onRefreshUsage}
              style={{ fontSize: '11px', padding: '2px 6px' }}
              aria-label="Refresh account usage"
            >
              Refresh
            </button>
          )}
        </div>
        {isMockMode ? (
          <>
            <div className="gb-muted">Subscription quota · sample</div>
            <div className="gb-bar" aria-hidden="true">
              <div className="gb-bar-fill" style={{ width: '32%' }} />
            </div>
            <small className="gb-muted">32% sample · not real quota</small>
          </>
        ) : runtimeSnapshot && runtimeSnapshot.usageWindows.length > 0 ? (
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
    </>
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
      overviewContent={overviewContent}
      filesTransport={filesTransport}
    />
  )
}
