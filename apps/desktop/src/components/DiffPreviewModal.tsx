import type { PendingApproval } from '../types/workspace.ts'

export function DiffPreviewModal({
  approval,
  onClose,
}: {
  approval: PendingApproval | null
  onClose: () => void
}) {
  if (!approval) return null

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Diff preview">
      <div className="gb-modal" style={{ maxWidth: '620px' }}>
        <div className="gb-modal-head">
          <strong>{approval.diffTitle}</strong>
          <button type="button" onClick={onClose} aria-label="Close diff preview">
            ×
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: '16px 18px',
            overflow: 'auto',
            fontSize: '12.5px',
            fontFamily: 'ui-monospace, monospace',
            background: 'var(--gb-surface)',
          }}
        >
          {approval.diffText}
        </pre>
        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--gb-border)' }}>
          <small className="gb-muted">
            Simulated diff preview — no actual filesystem changes are made in mock mode.
          </small>
        </div>
      </div>
    </div>
  )
}
