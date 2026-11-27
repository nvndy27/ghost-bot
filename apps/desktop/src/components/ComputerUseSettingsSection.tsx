import { useCallback, useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type {
  ComputerUseCapabilitiesDtoSchema,
  ComputerUseSessionDtoSchema,
} from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

type CuCapabilities = z.infer<typeof ComputerUseCapabilitiesDtoSchema>
type CuSession = z.infer<typeof ComputerUseSessionDtoSchema>

export interface ComputerUseSettingsSectionProps {
  bots: WorkspaceBot[]
  activeBotId: string | null
  onOpenLiveViewer: (sessionId?: string) => void
  onSessionsChanged?: () => void
}

export function ComputerUseSettingsSection({
  bots,
  activeBotId,
  onOpenLiveViewer,
  onSessionsChanged,
}: ComputerUseSettingsSectionProps) {
  const [capabilities, setCapabilities] = useState<CuCapabilities | null>(null)
  const [sessions, setSessions] = useState<CuSession[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Per-session creation & explicit consent form (never global persistent consent)
  const [botId, setBotId] = useState<string>(activeBotId ?? bots[0]?.id ?? '')
  const [allowObservation, setAllowObservation] = useState(true)
  const [allowNavigation, setAllowNavigation] = useState(true)
  const [allowInteraction, setAllowInteraction] = useState(true)
  const [allowedOriginsText, setAllowedOriginsText] = useState('http://127.0.0.1')
  const [explicitConsent, setExplicitConsent] = useState(false)

  const reqSeqRef = useRef(0)
  const onChangedRef = useRef(onSessionsChanged)
  onChangedRef.current = onSessionsChanged

  useEffect(() => {
    if (!botId && (activeBotId || bots[0]?.id)) {
      setBotId(activeBotId ?? bots[0]?.id ?? '')
    }
  }, [activeBotId, bots, botId])

  const loadData = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const [caps, sessRes] = await Promise.all([
        bridge.getComputerUseCapabilities(),
        bridge.listComputerUseSessions({ limit: 25 }),
      ])
      if (seq !== reqSeqRef.current) return
      setCapabilities(caps)
      setSessions(sessRes.sessions)
      setErrorMsg(null)
      onChangedRef.current?.()
    } catch (err) {
      if (seq !== reqSeqRef.current) return
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load Computer Use state')
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault()
    const bridge = window.ghostBot
    if (!bridge || submitting || !botId) return
    setSubmitting(true)
    setErrorMsg(null)
    setStatusMsg(null)
    try {
      const allowedOrigins = allowedOriginsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const created = await bridge.createComputerUseSession({
        botId,
        explicitConsent,
        inheritedFromTeamOrRoutine: false,
        allowObservation,
        allowNavigation,
        allowInteraction,
        allowedOrigins,
      })
      setExplicitConsent(false)
      setStatusMsg(`Started isolated browser session "${created.id}" (PID ${created.workerPid ?? '—'}).`)
      await loadData()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start Computer Use session')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCloseSession = async (sessionId: string) => {
    const bridge = window.ghostBot
    if (!bridge || submitting) return
    setSubmitting(true)
    setErrorMsg(null)
    try {
      await bridge.closeComputerUseSession({ sessionId })
      setStatusMsg(`Closed session "${sessionId}".`)
      await loadData()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to close session')
    } finally {
      setSubmitting(false)
    }
  }

  const handleEmergencyStop = async (sessionId: string) => {
    const bridge = window.ghostBot
    if (!bridge || submitting) return
    setSubmitting(true)
    setErrorMsg(null)
    try {
      const res = await bridge.emergencyStopComputerUseSession({
        sessionId,
        reason: 'Emergency stop from Settings',
      })
      setStatusMsg(
        res.confirmed
          ? `Emergency stop confirmed for "${sessionId}".`
          : `Emergency stop requested for "${sessionId}"; termination unconfirmed.`,
      )
      await loadData()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to emergency stop session')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div data-testid="computer-use-settings-section" style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>
            Computer Use <span className="gb-badge">Isolated Browser</span>
          </h2>
          <div className="gb-muted" style={{ fontSize: 12 }}>
            Daemon-owned Bubblewrap + sandboxed Chromium. Consent is per-session and never inherited by Teams or Routines.
          </div>
        </div>
        <button
          type="button"
          className="gb-btn-outline"
          onClick={() => onOpenLiveViewer(sessions.find((s) => s.state === 'active')?.id)}
        >
          Open Live Viewer
        </button>
      </div>

      {errorMsg && (
        <div
          role="alert"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--gb-danger, #c62828)',
            fontSize: 12,
          }}
        >
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div
          role="status"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--gb-border)',
            fontSize: 12,
          }}
        >
          {statusMsg}
        </div>
      )}

      {/* Discovered Capabilities vs Disabled Features */}
      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Daemon-Discovered Capabilities</strong>
        {loading && !capabilities ? (
          <div className="gb-muted" style={{ fontSize: 12 }}>Probing isolated runtime capabilities...</div>
        ) : capabilities ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
            <div>
              <div><strong>Isolated Browser:</strong> {capabilities.browser.sandboxed ? 'Available (Chromium sandbox)' : 'Unavailable'}</div>
              <div><strong>Executable:</strong> {capabilities.browser.executablePath ?? 'Unavailable'}</div>
              <div><strong>Context Isolation:</strong> {capabilities.browser.contextIsolation ? 'Enabled' : 'Disabled'}</div>
              <div><strong>Network Policy:</strong> {capabilities.browser.networkPolicyMode}</div>
            </div>
            <div>
              <div><strong>Virtual Desktop ({capabilities.virtualDesktop.backendKind}):</strong> {capabilities.virtualDesktop.compositorAvailable ? 'Socket PoC only' : 'Unavailable'}</div>
              <div><strong>VD Frame Capture / Input:</strong> Disabled ({String(capabilities.virtualDesktop.frameCaptureSupported)} / {String(capabilities.virtualDesktop.inputInjectionSupported)})</div>
              <div><strong>Host Desktop Control:</strong> Disabled ({String(capabilities.hostDesktopControlSupported)})</div>
              <div><strong>Live Model-Driven CU:</strong> Disabled ({String(capabilities.liveModelDrivenEnabled)})</div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Explicit Per-Session Launch & Consent */}
      <form className="gb-card" onSubmit={(e) => void handleCreateSession(e)} style={{ display: 'grid', gap: 10 }}>
        <strong style={{ fontSize: 13 }}>Start Isolated Browser Session</strong>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Target Bot</span>
            <select
              aria-label="Target Bot"
              className="gb-search-input"
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
            >
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.permission})
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Allowed Origins (comma-separated)</span>
            <input
              type="text"
              aria-label="Allowed Origins"
              className="gb-search-input"
              value={allowedOriginsText}
              onChange={(e) => setAllowedOriginsText(e.target.value)}
              placeholder="http://127.0.0.1"
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={allowObservation}
              onChange={(e) => setAllowObservation(e.target.checked)}
            />
            <span>Allow Observation</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={allowNavigation}
              onChange={(e) => setAllowNavigation(e.target.checked)}
            />
            <span>Allow Navigation (single-use approval)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={allowInteraction}
              onChange={(e) => setAllowInteraction(e.target.checked)}
            />
            <span>Allow Interaction (single-use approval)</span>
          </label>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={explicitConsent}
            onChange={(e) => setExplicitConsent(e.target.checked)}
          />
          <span>
            I explicitly consent to launch an isolated browser session for this bot (single-session only; never global or inherited).
          </span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" className="gb-btn-accent" disabled={submitting || !botId}>
            {submitting ? 'Starting...' : 'Start Isolated Session'}
          </button>
        </div>
      </form>

      {/* Active & Recent Sessions */}
      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>Computer Use Sessions ({sessions.length})</strong>
        {sessions.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12 }}>No Computer Use sessions yet.</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--gb-border)',
                fontSize: 12,
              }}
            >
              <div>
                <strong>{s.id}</strong> · <span className="gb-badge">{s.state}</span> · bot: {s.botId} · PID: {s.workerPid ?? '—'}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ fontSize: 11, padding: '3px 8px' }}
                  onClick={() => onOpenLiveViewer(s.id)}
                >
                  Open Live Viewer
                </button>
                {s.state === 'active' && (
                  <>
                    <button
                      type="button"
                      className="gb-btn-outline"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => void handleCloseSession(s.id)}
                      disabled={submitting}
                    >
                      Close
                    </button>
                    <button
                      type="button"
                      className="gb-btn-outline"
                      style={{ fontSize: 11, padding: '3px 8px' }}
                      onClick={() => void handleEmergencyStop(s.id)}
                      disabled={submitting}
                    >
                      Emergency Stop
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
