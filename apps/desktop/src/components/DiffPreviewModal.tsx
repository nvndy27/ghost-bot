import { useRef } from 'react'
import { X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { PendingApproval } from '../types/workspace.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export function DiffPreviewModal({
  approval,
  onClose,
}: {
  approval: PendingApproval | null
  onClose: () => void
}) {
  const modalRef = useRef<HTMLDivElement | null>(null)
  useModalDialog(approval !== null, modalRef, onClose)

  if (!approval) return null

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Diff preview">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="gb-modal"
        style={{ maxWidth: '620px' }}
      >
        <div className="gb-modal-head">
          <strong>{approval.diffTitle}</strong>
          <IconButton label="Close diff preview" onClick={onClose}>
            <X size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
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
