import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type {
  ComputerUseActionSchema,
  ComputerUseApprovalDtoSchema,
  ComputerUseLedgerEntryDtoSchema,
  ComputerUseObservationDtoSchema,
  ComputerUseSessionDtoSchema,
} from '@ghost-bot/shared-types/ipc'
import { useModalDialog } from '../hooks/useModalDialog'

type CuSession = z.infer<typeof ComputerUseSessionDtoSchema>
type CuObservation = z.infer<typeof ComputerUseObservationDtoSchema>
type CuApproval = z.infer<typeof ComputerUseApprovalDtoSchema>
type CuLedgerEntry = z.infer<typeof ComputerUseLedgerEntryDtoSchema>
type CuAction = z.infer<typeof ComputerUseActionSchema>

export interface ComputerUseLiveViewerModalProps {
  open: boolean
  initialSessionId?: string | null
  onClose: () => void
  onSessionsChanged?: () => void
}

export function mapScreenshotPointToViewport(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0 }
  }
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height)
  const renderedWidth = viewport.width * scale
  const renderedHeight = viewport.height * scale
  const offsetX = rect.left + (rect.width - renderedWidth) / 2
  const offsetY = rect.top + (rect.height - renderedHeight) / 2
  const x = Math.round(Math.max(0, Math.min(viewport.width, (clientX - offsetX) / scale)))
  const y = Math.round(Math.max(0, Math.min(viewport.height, (clientY - offsetY) / scale)))
  return { x, y }
}

export function ComputerUseLiveViewerModal({
  open,
  initialSessionId,
  onClose,
  onSessionsChanged,
}: ComputerUseLiveViewerModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  useModalDialog(open, dialogRef, onClose)

  const [sessions, setSessions] = useState<CuSession[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string>('')
  const [observation, setObservation] = useState<CuObservation | null>(null)
  const [approvals, setApprovals] = useState<CuApproval[]>([])
  const [ledger, setLedger] = useState<CuLedgerEntry[]>([])
  const [polling, setPolling] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [stopPhase, setStopPhase] = useState<'idle' | 'stopping' | 'confirmed' | 'unconfirmed'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Action preview form state (requires single-use approval before execution)
  const [actionKind, setActionKind] = useState<CuAction['kind']>('navigate')
  const [actionUrl, setActionUrl] = useState('http://127.0.0.1')
  const [actionSelector, setActionSelector] = useState('#q')
  const [actionText, setActionText] = useState('')
  const [clickX, setClickX] = useState(100)
  const [clickY, setClickY] = useState(100)
  const [deltaX, setDeltaX] = useState(0)
  const [deltaY, setDeltaY] = useState(200)
  const [pressKey, setPressKey] = useState('Enter')
  const [isComposing, setIsComposing] = useState(false)

  const sessionSeqRef = useRef(0)
  const frameInFlightRef = useRef(false)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const pendingActionMapRef = useRef(
    new Map<string, { action: CuAction; observationId: string; navigationGeneration: number }>(),
  )
  const onChangedRef = useRef(onSessionsChanged)
  onChangedRef.current = onSessionsChanged

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) ?? null

  const refreshSessions = useCallback(async (preferredId?: string | null) => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      const res = await bridge.listComputerUseSessions({ limit: 25 })
      setSessions(res.sessions)
      const target =
        preferredId && res.sessions.some((s) => s.id === preferredId)
          ? preferredId
          : res.sessions.find((s) => s.state === 'active')?.id ?? res.sessions[0]?.id ?? ''
      setSelectedSessionId((prev) => (prev && res.sessions.some((s) => s.id === prev) ? prev : target))
      onChangedRef.current?.()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load Computer Use sessions')
    }
  }, [])

  const loadSessionAudit = useCallback(async (sessionId: string) => {
    const bridge = window.ghostBot
    if (!bridge || !sessionId) return
    const seq = sessionSeqRef.current
    try {
      const [sess, appRes, ledRes] = await Promise.all([
        bridge.getComputerUseSession({ sessionId }),
        bridge.listComputerUseApprovals({ sessionId, limit: 25 }),
        bridge.listComputerUseLedger({ sessionId, limit: 30 }),
      ])
      if (seq !== sessionSeqRef.current) return
      setSessions((prev) => prev.map((s) => (s.id === sess.id ? sess : s)))
      setApprovals(appRes.approvals)
      setLedger(ledRes.entries)
    } catch (err) {
      if (seq !== sessionSeqRef.current) return
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load session audit state')
    }
  }, [])

  const captureFrame = useCallback(async (sessionId: string, tabId?: string) => {
    const bridge = window.ghostBot
    if (!bridge || !sessionId || frameInFlightRef.current) return
    const seq = sessionSeqRef.current
    frameInFlightRef.current = true
    try {
      const obs = await bridge.observeComputerUseTab({ sessionId, ...(tabId ? { tabId } : {}) })
      if (seq !== sessionSeqRef.current) return
      if (
        obs.byteLength > 2 * 1024 * 1024 ||
        obs.viewport.width <= 0 ||
        obs.viewport.height <= 0 ||
        !obs.imageBase64
      ) {
        throw new Error('Rejected invalid or oversized observation frame')
      }
      setObservation(obs)
      setErrorMsg(null)
    } catch (err) {
      if (seq !== sessionSeqRef.current) return
      setPolling(false)
      setErrorMsg(err instanceof Error ? err.message : 'Observation failed')
    } finally {
      frameInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) {
      setPolling(false)
      return
    }
    setStopPhase('idle')
    void refreshSessions(initialSessionId)
  }, [open, initialSessionId, refreshSessions])

  const sessionsRef = useRef<CuSession[]>([])
  sessionsRef.current = sessions

  useEffect(() => {
    if (!open || !selectedSessionId) return
    sessionSeqRef.current += 1
    setObservation(null)
    setApprovals([])
    setLedger([])
    setStopPhase('idle')
    void loadSessionAudit(selectedSessionId)
    const s = sessionsRef.current.find((item) => item.id === selectedSessionId)
    if (s?.state === 'active' && s.allowObservation) {
      void captureFrame(selectedSessionId, s.activeTabId ?? undefined)
    }
  }, [open, selectedSessionId, loadSessionAudit, captureFrame])

  // Bounded 2 FPS polling only when open, visible, active, and polling enabled
  useEffect(() => {
    if (!open || !polling || !selectedSession || selectedSession.state !== 'active') return
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void captureFrame(selectedSession.id, selectedSession.activeTabId ?? undefined)
    }, 600)
    return () => clearInterval(timer)
  }, [open, polling, selectedSession, captureFrame])

  if (!open) return null

  const buildActionPayload = (): CuAction | null => {
    const tabId = observation?.tabId ?? selectedSession?.activeTabId
    if (!tabId) return null
    const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    switch (actionKind) {
      case 'navigate':
        return { actionId, kind: 'navigate', tabId, url: actionUrl.trim() }
      case 'click_selector':
        return {
          actionId,
          kind: 'click_selector',
          tabId,
          selector: actionSelector.trim(),
          observationId: observation?.observationId,
          navigationGeneration: observation?.navigationGeneration,
        }
      case 'click_point':
        return {
          actionId,
          kind: 'click_point',
          tabId,
          x: clickX,
          y: clickY,
          observationId: observation?.observationId,
          navigationGeneration: observation?.navigationGeneration,
        }
      case 'type_text':
        return {
          actionId,
          kind: 'type_text',
          tabId,
          selector: actionSelector.trim(),
          text: actionText,
          observationId: observation?.observationId,
          navigationGeneration: observation?.navigationGeneration,
        }
      case 'scroll':
        return {
          actionId,
          kind: 'scroll',
          tabId,
          deltaX,
          deltaY,
          observationId: observation?.observationId,
          navigationGeneration: observation?.navigationGeneration,
        }
      case 'key_press':
        return {
          actionId,
          kind: 'key_press',
          tabId,
          key: pressKey,
          observationId: observation?.observationId,
          navigationGeneration: observation?.navigationGeneration,
        }
    }
  }

  const handleRequestApproval = async (e: React.FormEvent) => {
    e.preventDefault()
    const bridge = window.ghostBot
    if (!bridge || !selectedSession || !observation || submitting || isComposing) return
    const action = buildActionPayload()
    if (!action) {
      setErrorMsg('Capture an observation first to bind tab and navigation generation.')
      return
    }
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const app = await bridge.requestComputerUseApproval({
        sessionId: selectedSession.id,
        tabId: observation.tabId,
        observationId: observation.observationId,
        navigationGeneration: observation.navigationGeneration,
        action,
      })
      // Store previewed action temporarily in session memory mapped by approvalId
      pendingActionMapRef.current.set(app.id, {
        action,
        observationId: observation.observationId,
        navigationGeneration: observation.navigationGeneration,
      })
      setStatusMsg(`Approval "${app.id}" requested for ${action.kind}.`)
      await loadSessionAudit(selectedSession.id)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to request approval')
    } finally {
      setSubmitting(false)
    }
  }

  const handleResolveApproval = async (approvalId: string, decision: 'approved' | 'denied') => {
    const bridge = window.ghostBot
    if (!bridge || !selectedSession || submitting) return
    setSubmitting(true)
    setErrorMsg(null)
    try {
      await bridge.resolveComputerUseApproval({
        sessionId: selectedSession.id,
        approvalId,
        decision,
      })
      setStatusMsg(`Approval "${approvalId}" ${decision}.`)
      await loadSessionAudit(selectedSession.id)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve approval')
    } finally {
      setSubmitting(false)
    }
  }

  const handleExecuteApproved = async (app: CuApproval) => {
    const bridge = window.ghostBot
    if (!bridge || !selectedSession || submitting) return
    const bound = pendingActionMapRef.current.get(app.id)
    if (!bound) {
      setErrorMsg('Action payload is not bound in current viewer context.')
      return
    }
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const res = await bridge.executeComputerUseAction({
        sessionId: selectedSession.id,
        approvalId: app.id,
        observationId: bound.observationId,
        navigationGeneration: bound.navigationGeneration,
        action: bound.action,
      })
      setStatusMsg(`Action ${app.actionKind}: ${res.outcomeStatus} (${res.sanitizedSummary})`)
      await Promise.all([
        loadSessionAudit(selectedSession.id),
        captureFrame(selectedSession.id, app.tabId),
      ])
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Action execution failed')
      await loadSessionAudit(selectedSession.id)
    } finally {
      setSubmitting(false)
    }
  }

  const handleEmergencyStop = async () => {
    const bridge = window.ghostBot
    if (!bridge || !selectedSession || stopPhase === 'stopping') return
    setStopPhase('stopping')
    setPolling(false)
    setErrorMsg(null)
    try {
      const res = await bridge.emergencyStopComputerUseSession({
        sessionId: selectedSession.id,
        reason: 'Emergency stop from Live Viewer',
      })
      setStopPhase(res.confirmed ? 'confirmed' : 'unconfirmed')
      setStatusMsg(
        res.confirmed
          ? 'Emergency Stop confirmed: isolated browser worker terminated.'
          : 'Emergency Stop requested: underlying termination unconfirmed.',
      )
      await loadSessionAudit(selectedSession.id)
      onChangedRef.current?.()
    } catch (err) {
      setStopPhase('unconfirmed')
      setErrorMsg(err instanceof Error ? err.message : 'Emergency stop error')
    }
  }

  const handleScreenshotClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!observation || !imgRef.current) return
    const pt = mapScreenshotPointToViewport(
      e.clientX,
      e.clientY,
      imgRef.current.getBoundingClientRect(),
      observation.viewport,
    )
    setClickX(pt.x)
    setClickY(pt.y)
    setActionKind('click_point')
    setStatusMsg(`Captured preview coordinates (${pt.x}, ${pt.y}) — approval required before execution.`)
  }

  return (
    <div className="gb-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Computer Use Live Viewer"
        data-testid="cu-live-viewer-modal"
        className="gb-modal"
        style={{
          width: maximized ? 'min(96vw, 1360px)' : 'min(92vw, 1080px)',
          height: maximized ? 'min(92vh, 860px)' : 'min(85vh, 760px)',
          display: 'grid',
          gridTemplateRows: 'auto auto 1fr',
          gap: 10,
          padding: 14,
        }}
      >
        {/* Header Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15 }}>Computer Use Live Viewer</strong>
            <select
              aria-label="Select Computer Use Session"
              className="gb-search-input"
              style={{ width: 220 }}
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
            >
              {sessions.length === 0 && <option value="">No sessions</option>}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 14)} · {s.state}
                </option>
              ))}
            </select>
            {selectedSession && (
              <span className="gb-badge">
                {selectedSession.state} · PID {selectedSession.workerPid ?? '—'}
              </span>
            )}
            {stopPhase === 'confirmed' && <span className="gb-badge">Confirmed termination</span>}
            {stopPhase === 'unconfirmed' && <span className="gb-badge">Unconfirmed termination</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {selectedSession?.state === 'active' && (
              <button
                type="button"
                className="gb-btn-accent"
                data-testid="cu-emergency-stop-btn"
                disabled={stopPhase === 'stopping'}
                onClick={() => void handleEmergencyStop()}
              >
                {stopPhase === 'stopping' ? 'Stopping worker...' : 'Emergency Stop'}
              </button>
            )}
            <button
              type="button"
              className="gb-btn-outline"
              onClick={() => setMaximized((m) => !m)}
            >
              {maximized ? 'Restore' : 'Maximize'}
            </button>
            <button type="button" className="gb-btn-outline" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {(errorMsg || statusMsg) && (
          <div style={{ display: 'grid', gap: 4 }}>
            {errorMsg && (
              <div role="alert" style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--gb-danger, #c62828)' }}>
                {errorMsg}
              </div>
            )}
            {statusMsg && (
              <div role="status" style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--gb-border)' }}>
                {statusMsg}
              </div>
            )}
          </div>
        )}

        {/* Main 2-column Viewer + Controls/Approvals/Ledger */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12, minHeight: 0, overflow: 'hidden' }}>
          {/* Left: Isolated Screenshot Canvas */}
          <div className="gb-card" style={{ display: 'grid', gridTemplateRows: 'auto 1fr auto', gap: 8, minHeight: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <span>
                <strong>URL:</strong> {observation?.url ?? '—'} · <strong>Gen:</strong> {observation?.navigationGeneration ?? '—'}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={!selectedSession || selectedSession.state !== 'active'}
                  onClick={() => selectedSession && void captureFrame(selectedSession.id, selectedSession.activeTabId ?? undefined)}
                >
                  Refresh Frame
                </button>
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  disabled={!selectedSession || selectedSession.state !== 'active'}
                  onClick={() => setPolling((p) => !p)}
                >
                  {polling ? 'Pause Poll' : 'Auto Poll (2 FPS)'}
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderRadius: 8, border: '1px solid var(--gb-border)', background: 'var(--gb-bg-subtle, rgba(0,0,0,0.06))' }}>
              {observation ? (
                <img
                  ref={imgRef}
                  src={`data:image/png;base64,${observation.imageBase64}`}
                  alt={`Isolated browser tab ${observation.tabId}`}
                  onClick={handleScreenshotClick}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', cursor: 'crosshair' }}
                />
              ) : (
                <div className="gb-muted" style={{ fontSize: 12, padding: 16 }}>
                  {selectedSession?.state === 'active'
                    ? 'Capturing isolated browser observation...'
                    : `Session ${selectedSession?.state ?? 'unavailable'}.`}
                </div>
              )}
            </div>

            <div className="gb-muted" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span>
                Frame #{observation?.viewerFrame.frameSeq ?? 0} · {observation?.byteLength ?? 0} bytes · Obs: {observation?.observationId ?? '—'}
              </span>
              <span>
                Stale: {String(observation?.viewerFrame.stale ?? false)} · Dropped: {observation?.viewerFrame.backpressureDropCount ?? 0}
              </span>
            </div>
          </div>

          {/* Right: Action Preview, Approvals, and Sanitized Ledger */}
          <div style={{ display: 'grid', gap: 10, overflowY: 'auto', paddingRight: 4 }}>
            <form className="gb-card" onSubmit={(e) => void handleRequestApproval(e)} style={{ display: 'grid', gap: 8 }}>
              <strong style={{ fontSize: 13 }}>Action Preview (Single-Use Approval Required)</strong>
              <select
                aria-label="Action Kind"
                className="gb-search-input"
                value={actionKind}
                onChange={(e) => setActionKind(e.target.value as CuAction['kind'])}
              >
                <option value="navigate">navigate</option>
                <option value="click_selector">click_selector</option>
                <option value="click_point">click_point</option>
                <option value="type_text">type_text</option>
                <option value="scroll">scroll</option>
                <option value="key_press">key_press</option>
              </select>

              {actionKind === 'navigate' && (
                <input
                  type="text"
                  aria-label="Target URL"
                  className="gb-search-input"
                  value={actionUrl}
                  onChange={(e) => setActionUrl(e.target.value)}
                  placeholder="http://127.0.0.1:..."
                />
              )}
              {(actionKind === 'click_selector' || actionKind === 'type_text') && (
                <input
                  type="text"
                  aria-label="CSS Selector"
                  className="gb-search-input"
                  value={actionSelector}
                  onChange={(e) => setActionSelector(e.target.value)}
                  placeholder="#selector"
                />
              )}
              {actionKind === 'type_text' && (
                <input
                  type="text"
                  aria-label="Text to Type"
                  className="gb-search-input"
                  value={actionText}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={() => setIsComposing(false)}
                  onChange={(e) => setActionText(e.target.value)}
                  placeholder="Text (redacted in ledger)"
                />
              )}
              {actionKind === 'click_point' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <input
                    type="number"
                    aria-label="Click X"
                    className="gb-search-input"
                    value={clickX}
                    onChange={(e) => setClickX(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    aria-label="Click Y"
                    className="gb-search-input"
                    value={clickY}
                    onChange={(e) => setClickY(Number(e.target.value))}
                  />
                </div>
              )}
              {actionKind === 'scroll' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <input
                    type="number"
                    aria-label="Scroll Delta X"
                    className="gb-search-input"
                    value={deltaX}
                    onChange={(e) => setDeltaX(Number(e.target.value))}
                  />
                  <input
                    type="number"
                    aria-label="Scroll Delta Y"
                    className="gb-search-input"
                    value={deltaY}
                    onChange={(e) => setDeltaY(Number(e.target.value))}
                  />
                </div>
              )}
              {actionKind === 'key_press' && (
                <input
                  type="text"
                  aria-label="Key Name"
                  className="gb-search-input"
                  value={pressKey}
                  onChange={(e) => setPressKey(e.target.value)}
                />
              )}

              <button
                type="submit"
                className="gb-btn-accent"
                disabled={submitting || !selectedSession || selectedSession.state !== 'active' || !observation}
              >
                Request Approval
              </button>
            </form>

            {/* Approvals */}
            <div className="gb-card" style={{ display: 'grid', gap: 6 }}>
              <strong style={{ fontSize: 13 }}>Action Approvals ({approvals.length})</strong>
              {approvals.length === 0 ? (
                <div className="gb-muted" style={{ fontSize: 12 }}>No action approvals yet.</div>
              ) : (
                approvals.map((app) => (
                  <div key={app.id} style={{ fontSize: 12, padding: 6, borderRadius: 6, border: '1px solid var(--gb-border)', display: 'grid', gap: 4 }}>
                    <div>
                      <strong>{app.actionKind}</strong> · <span className="gb-badge">{app.status}</span> · gen {app.navigationGeneration}
                    </div>
                    <div className="gb-muted" style={{ fontSize: 11 }}>
                      Bot: {app.botId} · Obs: {app.observationId.slice(0, 12)} · Exp: {app.expiresAt}
                    </div>
                    {app.status === 'pending' && selectedSession?.state === 'active' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="gb-btn-accent" style={{ fontSize: 11, padding: '2px 8px' }} disabled={submitting} onClick={() => void handleResolveApproval(app.id, 'approved')}>
                          Approve once
                        </button>
                        <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '2px 8px' }} disabled={submitting} onClick={() => void handleResolveApproval(app.id, 'denied')}>
                          Deny
                        </button>
                      </div>
                    )}
                    {app.status === 'approved' && selectedSession?.state === 'active' && (
                      <button type="button" className="gb-btn-accent" style={{ fontSize: 11, padding: '2px 8px' }} disabled={submitting} onClick={() => void handleExecuteApproved(app)}>
                        Execute Approved Action
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Sanitized Action Ledger */}
            <div className="gb-card" style={{ display: 'grid', gap: 6 }}>
              <strong style={{ fontSize: 13 }}>Action Ledger ({ledger.length})</strong>
              {ledger.length === 0 ? (
                <div className="gb-muted" style={{ fontSize: 12 }}>No ledger entries yet.</div>
              ) : (
                ledger.map((entry) => (
                  <div key={entry.id} style={{ fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--gb-border)' }}>
                    <strong>{entry.actionKind}</strong> · <span className="gb-badge">{entry.outcomeStatus}</span>
                    {entry.outcomeStatus === 'uncertain' && ' · UNCERTAIN (replay forbidden)'}
                    <div className="gb-muted">{entry.sanitizedSummary}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
