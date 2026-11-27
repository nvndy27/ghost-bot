import type { RoutineRecordDto, RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import {
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  FolderOpen,
  ListTodo,
  Loader2,
  Monitor,
  PanelRight,
  Plug,
  RefreshCw,
  Terminal,
} from 'lucide-react'
import { MOCK_ROUTINES, MOCK_TOOLS } from '../data/mockWorkspace.ts'
import type { ToolStep, WorkspaceBot } from '../types/workspace.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface RightPanelProps {
  width: number
  bot: WorkspaceBot | null
  activeTasks: ToolStep[]
  runtimeSnapshot: RuntimeSnapshot | null
  isMockMode: boolean
  routines?: RoutineRecordDto[]
  unreadRoutineNotifications?: number
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
  onOpenRoutines,
  onOpenComputerUse,
  onOpenTerminal,
  onRefreshUsage,
  onReconnectRuntime,
  onCollapse,
}: RightPanelProps) {
  return (
    <aside
      className="gb-right-panel"
      style={{ width: `${width}px` }}
      aria-label="Bot workspace panel"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px',
        }}
      >
        <strong className="gb-icon-inline" style={{ fontSize: '14px' }}>
          <FolderOpen size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)' }} />
          <span>Bot workspace</span>
        </strong>
        <IconButton
          label="Collapse workspace panel"
          onClick={onCollapse}
          active
          pressed
        >
          <PanelRight size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      </div>

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <Monitor size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)' }} />
          <span>Live computer</span>
        </div>
        <small className="gb-muted">
          {onOpenComputerUse ? 'Isolated browser · ready' : isMockMode ? 'Mock preview · unavailable' : 'Unavailable'}
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
        <div className="gb-section-label gb-icon-inline">
          <ListTodo size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>Active tasks</span>
        </div>
        {activeTasks.length === 0 ? (
          <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
            No active tasks.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {activeTasks.map((t) => (
              <div key={t.id} style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                {t.status === 'done' ? (
                  <Check size={ICON_SIZE.xs} strokeWidth={2.2} aria-hidden="true" style={{ color: 'var(--gb-success)', flexShrink: 0 }} />
                ) : (
                  <Loader2 size={ICON_SIZE.xs} strokeWidth={2} className="gb-spin" aria-hidden="true" style={{ color: 'var(--gb-muted)', flexShrink: 0 }} />
                )}
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
          <span className="gb-icon-inline">
            <CalendarClock size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>Routines</span>
            {unreadRoutineNotifications > 0 && (
              <span className="gb-badge" style={{ marginLeft: 4 }}>
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
                <div className="gb-icon-inline" style={{ gap: '6px' }}>
                  <CalendarClock size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)', flexShrink: 0 }} />
                  <span>{rt.name}</span>
                  <span className="gb-badge">
                    {rt.enabled ? (isMockMode ? 'Mock' : 'Gated') : 'Paused'}
                  </span>
                </div>
                <div className="gb-muted" style={{ paddingLeft: '20px', fontSize: '12px' }}>
                  {rt.nextRunAt ? `Next: ${rt.nextRunAt}` : `${rt.timezone} · ${String(rt.trigger.kind)}`}
                </div>
              </div>
            ))
          )
        ) : (
          MOCK_ROUTINES.map((rt) => (
            <div key={rt.id} style={{ marginBottom: '10px' }}>
              <div className="gb-icon-inline" style={{ gap: '6px' }}>
                <CalendarClock size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)', flexShrink: 0 }} />
                <span>{rt.name}</span>
                <span className="gb-badge">Phase 5</span>
              </div>
              <div className="gb-muted" style={{ paddingLeft: '20px', fontSize: '12px' }}>
                {rt.schedule}
              </div>
            </div>
          ))
        )}
      </div>

      <hr className="gb-divider" />

      <div>
        <div className="gb-section-label gb-icon-inline">
          <Plug size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
          <span>Connected tools</span>
        </div>
        {isMockMode ? (
          MOCK_TOOLS.map((tool) => (
            <div
              key={tool.id}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}
            >
              <span className="gb-icon-inline" style={{ gap: '6px' }}>
                {tool.kind === 'terminal' ? (
                  <Terminal size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)' }} />
                ) : (
                  <Plug size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-muted)' }} />
                )}
                <span>{tool.kind === 'terminal' && onOpenTerminal ? 'Scoped Terminal' : tool.name}</span>
              </span>
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
                    Resets {new Date(w.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </small>
                )}
              </div>
            ))}
            <small className="gb-muted" style={{ fontSize: '11px' }}>
              Status: {runtimeSnapshot.status === 'stale' ? 'stale' : runtimeSnapshot.usageStatus}
              {runtimeSnapshot.usageObservedAt
                ? ` · Refreshed ${new Date(runtimeSnapshot.usageObservedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </small>
            {runtimeSnapshot.lifecycleState && runtimeSnapshot.lifecycleState !== 'connected' && onReconnectRuntime && (
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
    </aside>
  )
}
