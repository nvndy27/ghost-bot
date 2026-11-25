import type { RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import { MOCK_ROUTINES, MOCK_TOOLS } from '../data/mockWorkspace.ts'
import type { ToolStep, WorkspaceBot } from '../types/workspace.ts'

export interface RightPanelProps {
  width: number
  bot: WorkspaceBot | null
  activeTasks: ToolStep[]
  runtimeSnapshot: RuntimeSnapshot | null
  isMockMode: boolean
  onCollapse: () => void
}

export function RightPanel({
  width,
  bot,
  activeTasks,
  runtimeSnapshot,
  isMockMode,
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
        <strong style={{ fontSize: '14px' }}>Bot workspace</strong>
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse workspace panel"
          aria-label="Collapse workspace panel"
        >
          »
        </button>
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
        <div>Live computer</div>
        <small className="gb-muted">
          {isMockMode ? 'Mock preview · unavailable' : 'Unavailable (Phase 5)'}
        </small>
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
        <div className="gb-section-label">Routines</div>
        {MOCK_ROUTINES.map((rt) => (
          <div key={rt.id} style={{ marginBottom: '10px' }}>
            <div>
              ◷ {rt.name} <span className="gb-badge">Phase 5</span>
            </div>
            <div className="gb-muted" style={{ paddingLeft: '18px', fontSize: '12px' }}>
              {rt.schedule}
            </div>
          </div>
        ))}
      </div>

      <hr className="gb-divider" />

      <div>
        <div className="gb-section-label">Connected tools</div>
        {isMockMode ? (
          MOCK_TOOLS.map((tool) => (
            <div
              key={tool.id}
              style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}
            >
              <span>{tool.name}</span>
              <span className="gb-badge">{tool.note}</span>
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
        <div className="gb-section-label">Account usage</div>
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
            {runtimeSnapshot.usageWindows.map((w) => (
              <div key={w.label}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                  <span className="gb-muted">Window {w.label}</span>
                  <span>{w.usedPercent !== null ? `${w.usedPercent}%` : 'Unavailable'}</span>
                </div>
                <div className="gb-bar" aria-hidden="true">
                  <div className="gb-bar-fill" style={{ width: `${w.usedPercent ?? 0}%` }} />
                </div>
              </div>
            ))}
            <small className="gb-muted" style={{ fontSize: '11px' }}>
              Status: {runtimeSnapshot.usageStatus}
            </small>
          </div>
        ) : (
          <p className="gb-muted" style={{ margin: '4px 0', fontSize: '12.5px' }}>
            {runtimeSnapshot
              ? `Usage ${runtimeSnapshot.usageStatus}`
              : 'Usage unavailable.'}
          </p>
        )}
      </div>
    </aside>
  )
}
