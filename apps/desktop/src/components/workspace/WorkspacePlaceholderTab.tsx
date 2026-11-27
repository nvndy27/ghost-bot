import type { WorkspaceTabDefinition } from './workspaceTabs.ts'

export interface WorkspacePlaceholderTabProps {
  tab: WorkspaceTabDefinition
  contextLabel: string
  workspacePath?: string | null
  isMockMode: boolean
}

export function WorkspacePlaceholderTab({
  tab,
  contextLabel,
  workspacePath,
  isMockMode,
}: WorkspacePlaceholderTabProps) {
  return (
    <section
      className="gb-workspace-placeholder"
      data-testid={`workspace-placeholder-${tab.id}`}
      aria-label={`${tab.label} unavailable`}
    >
      <div className="gb-workspace-placeholder-head">
        <strong style={{ fontSize: '13px' }}>{tab.label}</strong>
        <span className="gb-badge">
          {tab.milestone ? `${tab.milestone} · Not yet implemented` : 'Unavailable'}
        </span>
      </div>

      <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
        {tab.summary}
      </p>

      {tab.id === 'browser' && (
        <p className="gb-muted" style={{ margin: 0, fontSize: '12px' }}>
          Isolated Computer Use remains available from the Overview tab when enabled.
        </p>
      )}

      {tab.id === 'output' && (
        <p className="gb-muted" style={{ margin: 0, fontSize: '12px' }}>
          Scoped Terminal remains a separate gated tool in Overview.
        </p>
      )}

      <div className="gb-workspace-placeholder-meta">
        <div>
          <span className="gb-muted">Active context: </span>
          <span>{contextLabel}</span>
          {isMockMode && (
            <span className="gb-badge" style={{ marginLeft: 6 }}>
              Mock
            </span>
          )}
        </div>
        <div>
          <span className="gb-muted">Authorized workspace: </span>
          <span className="gb-workspace-path">
            {workspacePath && workspacePath.trim().length > 0
              ? workspacePath
              : 'Not configured'}
          </span>
        </div>
      </div>
    </section>
  )
}
