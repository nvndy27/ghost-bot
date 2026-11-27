import { ArrowUp, Square } from 'lucide-react'
import { ICON_SIZE } from './IconButton.tsx'

export function ComposerSendButton({ canSend, stopping, onStop, sendLabel, stopLabel, disabledTitle }: {
  canSend: boolean
  stopping: boolean
  onStop: () => void
  sendLabel: string
  stopLabel: string
  disabledTitle: string
}) {
  return stopping ? (
    <button type="button" className="gb-send-btn gb-stop-btn" onClick={onStop} title={stopLabel} aria-label={stopLabel}>
      <Square size={13} strokeWidth={2} fill="currentColor" aria-hidden="true" />
    </button>
  ) : (
    <button type="submit" className={`gb-send-btn${canSend ? ' ready' : ''}`} disabled={!canSend}
      title={canSend ? sendLabel : disabledTitle} aria-label={sendLabel}>
      <ArrowUp size={ICON_SIZE.md} strokeWidth={2.1} aria-hidden="true" />
    </button>
  )
}
