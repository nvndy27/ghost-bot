import { ArrowLeft, ArrowRight, Camera, Monitor, Plus, RefreshCw, Smartphone, Square, Terminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkspaceBrowserState } from '@ghost-bot/shared-types/ipc'
import './workspace-browser.css'

export interface WorkspaceBrowserTabProps {
  visible: boolean
  isMockMode: boolean
}

export function WorkspaceBrowserTab({ visible, isMockMode }: WorkspaceBrowserTabProps) {
  const bridge = typeof window !== 'undefined' ? window.ghostBot : undefined
  const supported = Boolean(
    bridge &&
      typeof bridge.workspaceBrowserCommand === 'function' &&
      typeof bridge.setWorkspaceBrowserBounds === 'function' &&
      typeof bridge.captureWorkspaceBrowser === 'function' &&
      typeof bridge.onWorkspaceBrowserState === 'function',
  )

  const [browserState, setBrowserState] = useState<WorkspaceBrowserState>({
    active: null,
    tabs: [],
  })
  const [urlInput, setUrlInput] = useState('http://127.0.0.1:3000')
  const [localError, setLocalError] = useState<string | null>(null)
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [showConsole, setShowConsole] = useState(false)
  const viewportRef = useRef<HTMLDivElement | null>(null)

  const activeTab =
    browserState.tabs.find((t) => t.id === browserState.active) ?? browserState.tabs[0] ?? null

  useEffect(() => {
    if (!supported || !bridge) return
    const unsub = bridge.onWorkspaceBrowserState((next) => {
      setBrowserState(next)
    })
    void bridge
      .workspaceBrowserCommand({ kind: 'state' })
      .then((initial) => setBrowserState(initial))
      .catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Browser state unavailable.')
      })
    return () => {
      unsub()
    }
  }, [bridge, supported])

  useEffect(() => {
    if (activeTab?.url) {
      setUrlInput(activeTab.url)
    }
  }, [activeTab?.id, activeTab?.url])

  const syncBounds = useCallback(() => {
    if (!supported || !bridge) return
    const obscured = Array.from(document.querySelectorAll('[role="dialog"], [role="menu"], [popover]:popover-open, .gb-modal-backdrop'))
      .some((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    if (obscured || !visible || !activeTab || !activeTab.url || !viewportRef.current) {
      void bridge.setWorkspaceBrowserBounds(null).catch(() => {})
      return
    }
    const rect = viewportRef.current.getBoundingClientRect()
    const width = Math.floor(rect.width)
    const height = Math.floor(rect.height)
    const x = Math.max(0, Math.floor(rect.left))
    const y = Math.max(0, Math.floor(rect.top))
    if (width < 1 || height < 1) {
      void bridge.setWorkspaceBrowserBounds(null).catch(() => {})
      return
    }
    void bridge
      .setWorkspaceBrowserBounds({
        x,
        y,
        width: Math.min(1600, width),
        height: Math.min(1200, height),
      })
      .catch(() => {})
  }, [activeTab, bridge, supported, visible])

  useEffect(() => {
    syncBounds()
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      return () => {
        if (supported && bridge) {
          void bridge.setWorkspaceBrowserBounds(null).catch(() => {})
        }
      }
    }
    const observer = new ResizeObserver(() => syncBounds())
    const overlays = new MutationObserver(() => syncBounds())
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-hidden'] })
    document.addEventListener('scroll', syncBounds, true)
    observer.observe(el)
    window.addEventListener('resize', syncBounds)
    return () => {
      observer.disconnect()
      overlays.disconnect()
      document.removeEventListener('scroll', syncBounds, true)
      window.removeEventListener('resize', syncBounds)
      if (supported && bridge) {
        void bridge.setWorkspaceBrowserBounds(null).catch(() => {})
      }
    }
  }, [bridge, supported, syncBounds])

  if (!supported || !bridge) {
    return (
      <section className="gb-workspace-placeholder" data-testid="workspace-browser-unavailable">
        <div className="gb-workspace-placeholder-head">
          <strong style={{ fontSize: '13px' }}>Browser</strong>
          <span className="gb-badge">Unavailable</span>
        </div>
        <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
          Isolated Electron WebContentsView browser bridge is not available in this environment.
          {isMockMode ? ' (Mock browser preview is disabled.)' : ''}
        </p>
      </section>
    )
  }

  const runCommand = async (cmd: Parameters<typeof bridge.workspaceBrowserCommand>[0]) => {
    setLocalError(null)
    try {
      const next = await bridge.workspaceBrowserCommand(cmd)
      setBrowserState(next)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Browser command failed.')
    }
  }

  const handleNavigate = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    let targetId = activeTab?.id
    if (!targetId) {
      const created = await bridge.workspaceBrowserCommand({ kind: 'new' }).catch((err: unknown) => {
        setLocalError(err instanceof Error ? err.message : 'Could not create tab.')
        return null
      })
      if (!created) return
      setBrowserState(created)
      targetId = created.active ?? created.tabs[0]?.id
    }
    if (!targetId) return
    await runCommand({ kind: 'navigate', tabId: targetId, url: trimmed })
  }

  const handleScreenshot = async () => {
    if (!activeTab) return
    setLocalError(null)
    try {
      const dataUrl = await bridge.captureWorkspaceBrowser(activeTab.id)
      setScreenshotUrl(dataUrl)
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Screenshot failed.')
    }
  }

  return (
    <div className="gb-browser-tab" data-testid="workspace-browser-tab">
      <div className="gb-browser-tabs-bar" role="tablist" aria-label="Browser tabs">
        {browserState.tabs.map((tab, idx) => {
          const isActive = tab.id === activeTab?.id
          return (
            <div
              key={tab.id}
              className={`gb-browser-tab-pill${isActive ? ' active' : ''}`}
              data-testid={`browser-tab-${idx}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="gb-browser-tab-title"
                style={{ padding: 0, border: 0, background: 'transparent', fontSize: 'inherit' }}
                onClick={() => void runCommand({ kind: 'select', tabId: tab.id })}
                title={tab.url || 'New tab'}
              >
                {tab.title || tab.url || `Tab ${idx + 1}`}
              </button>
              <button
                type="button"
                aria-label={`Close browser tab ${idx + 1}`}
                style={{ padding: '0 2px', border: 0, fontSize: 11 }}
                onClick={() => void runCommand({ kind: 'close', tabId: tab.id })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          className="gb-icon-btn"
          onClick={() => void runCommand({ kind: 'new' })}
          aria-label="New browser tab" title="New browser tab"
          data-testid="browser-new-tab-btn"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="gb-browser-toolbar">
        <button
          type="button"
          className="gb-icon-btn"
          title="Browser back" disabled={!activeTab?.back}
          onClick={() => activeTab && void runCommand({ kind: 'back', tabId: activeTab.id })}
          aria-label="Browser back"
          data-testid="browser-back-btn"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="gb-icon-btn"
          disabled={!activeTab?.forward}
          onClick={() => activeTab && void runCommand({ kind: 'forward', tabId: activeTab.id })}
          aria-label="Browser forward" title="Browser forward"
          data-testid="browser-forward-btn"
        >
          <ArrowRight size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="gb-icon-btn"
          disabled={!activeTab}
          onClick={() =>
            activeTab &&
            void runCommand({
              kind: activeTab.loading ? 'stop' : 'reload',
              tabId: activeTab.id,
            })
          }
          aria-label={activeTab?.loading ? 'Stop loading' : 'Reload page'} title={activeTab?.loading ? 'Stop loading' : 'Reload page'}
          data-testid="browser-reload-btn"
        >
          {activeTab?.loading ? <Square size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
        </button>

        <form className="gb-browser-url-form" onSubmit={(e) => void handleNavigate(e)}>
          <input
            type="url"
            className="gb-browser-url-input"
            aria-label="Browser URL"
            data-testid="browser-url-input"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="http://127.0.0.1:3000"
          />
          <button
            type="submit"
            className="gb-workspace-icon-btn"
            data-testid="browser-go-btn"
          >
            Go
          </button>
        </form>

        <button
          type="button"
          className="gb-icon-btn"
          disabled={!activeTab}
          aria-pressed={activeTab?.preset === 'mobile'}
          onClick={() =>
            activeTab &&
            void runCommand({
              kind: 'viewport',
              tabId: activeTab.id,
              preset: activeTab.preset === 'desktop' ? 'mobile' : 'desktop',
            })
          }
          aria-label="Toggle desktop or mobile viewport" title="Toggle desktop or mobile viewport"
          data-testid="browser-viewport-btn"
        >
          {activeTab?.preset === 'mobile' ? <Smartphone size={16} aria-hidden="true" /> : <Monitor size={16} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="gb-icon-btn"
          disabled={!activeTab?.url}
          onClick={() => void handleScreenshot()}
          aria-label="Capture browser screenshot" title="Capture browser screenshot"
          data-testid="browser-screenshot-btn"
        >
          <Camera size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="gb-icon-btn"
          aria-pressed={showConsole}
          onClick={() => setShowConsole((prev) => !prev)}
          aria-label="Toggle browser console" title="Toggle browser console"
          data-testid="browser-console-btn"
        >
          <Terminal size={16} aria-hidden="true" />
        </button>
      </div>

      {(localError || activeTab?.error) && (
        <div className="gb-browser-error" role="alert" data-testid="browser-error-banner">
          {localError ?? activeTab?.error}
        </div>
      )}

      {activeTab?.loading && (
        <div className="gb-muted" style={{ fontSize: 11.5 }} data-testid="browser-loading-status">
          Loading {activeTab.url}...
        </div>
      )}

      <div ref={viewportRef} className="gb-browser-viewport" data-testid="browser-viewport">
        {!activeTab?.url && (
          <span className="gb-muted" style={{ fontSize: 12, textAlign: 'center', padding: 12 }}>
            Enter a localhost or HTTP/HTTPS URL to preview inside an isolated browser session.
          </span>
        )}
      </div>

      {screenshotUrl && (
        <div className="gb-browser-shot" data-testid="browser-screenshot-preview">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="gb-section-label" style={{ margin: 0 }}>
              Screenshot
            </span>
            <button
              type="button"
              className="gb-icon-btn"
              onClick={() => setScreenshotUrl(null)}
            >
              Dismiss
            </button>
          </div>
          <img src={screenshotUrl} alt="Captured browser preview" />
        </div>
      )}

      {showConsole && (
        <div className="gb-browser-console" data-testid="browser-console-panel">
          {!activeTab || activeTab.console.length === 0 ? (
            <span className="gb-muted">No console events recorded.</span>
          ) : (
            activeTab.console.map((entry, idx) => (
              <div key={`${entry.time}-${idx}`}>
                [{entry.level}] {new Date(entry.time).toLocaleTimeString()} (redacted untrusted output)
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
