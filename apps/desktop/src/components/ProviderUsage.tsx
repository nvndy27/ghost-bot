import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import { ChartNoAxesColumn, RefreshCw, X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export function ProviderUsage({ snapshot, compact, onRefresh, onOpenSettings }: {
  snapshot: RuntimeSnapshot | null
  compact: boolean
  onRefresh: () => Promise<void>
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useModalDialog(open, dialog, close)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, close])
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRefresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Usage refresh failed')
    } finally {
      setBusy(false)
    }
  }
  const windows = snapshot?.runtimeMode === 'codex' ? snapshot.usageWindows : []
  return (
    <div className="gb-usage-anchor" ref={panel}>
      <button className="gb-settings-btn" type="button" aria-label="Provider usage"
        aria-expanded={open} aria-controls="gb-provider-usage" title="Provider usage"
        onClick={() => setOpen(!open)}>
        <ChartNoAxesColumn size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
        {!compact && <span>Usage</span>}
      </button>
      {open && <div ref={dialog} id="gb-provider-usage" className="gb-usage-popover" role="dialog" aria-label="Provider usage">
        <div className="gb-usage-heading">
          <strong>Provider usage</strong>
          <IconButton label="Refresh provider usage" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
          <IconButton label="Close provider usage" onClick={close}>
            <X size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>
        <p className="gb-muted">{snapshot?.runtimeMode === 'codex' ? 'Codex subscription' : 'No subscription usage available'}</p>
        {snapshot?.planType && <p>{snapshot.planType}</p>}
        {windows.map((window) => <div className="gb-usage-window" key={window.label}>
          <span>{window.label}</span>
          <strong>{window.usedPercent === null ? 'Unavailable' : `${window.usedPercent}% used`}</strong>
          {window.resetAt && <small className="gb-muted">Resets {new Date(window.resetAt).toLocaleString()}</small>}
        </div>)}
        {windows.length === 0 && <p className="gb-muted">Quota unavailable</p>}
        <small className="gb-muted">
          {snapshot ? `Status · ${snapshot.status === 'stale' ? 'stale' : snapshot.usageStatus}` : 'Runtime unavailable'}
          {snapshot?.usageObservedAt && ` · Observed ${new Date(snapshot.usageObservedAt).toLocaleString()}`}
        </small>
        <p className="gb-muted">Usage for other provider accounts is unavailable in the current runtime snapshot.</p>
        {busy && <p role="status">Refreshing usage…</p>}
        {error && <div role="alert">
          <p>Usage refresh failed. Try again or open Accounts &amp; Providers.</p>
          <details><summary>Error details</summary><p>{error}</p></details>
        </div>}
        <button type="button" className="gb-btn-outline" onClick={() => { close(); onOpenSettings() }}>Manage providers in Settings</button>
      </div>}
    </div>
  )
}
