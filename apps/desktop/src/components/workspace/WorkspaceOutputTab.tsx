import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  WorkspaceOutputEntry,
  WorkspaceOutputResponse,
} from '@ghost-bot/shared-types/ipc'
import './workspace-output.css'

export interface WorkspaceOutputTabProps {
  contextKey: string
  contextKind: 'bot' | 'team'
  ownerId: string | null
  isMockMode: boolean
}

export function WorkspaceOutputTab({
  contextKey,
  contextKind,
  ownerId,
  isMockMode,
}: WorkspaceOutputTabProps) {
  const bridge = typeof window !== 'undefined' ? window.ghostBot : undefined
  const supported = Boolean(
    bridge &&
      typeof bridge.listWorkspaceOutput === 'function' &&
      typeof bridge.cancelWorkspaceOutput === 'function',
  )

  const [data, setData] = useState<WorkspaceOutputResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [runFilter, setRunFilter] = useState<string>('all')
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [severityFilter, setSeverityFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [clearedAt, setClearedAt] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const epochRef = useRef(0)
  const streamRef = useRef<HTMLDivElement | null>(null)

  const loadOutput = useCallback(async () => {
    if (!supported || !bridge || !ownerId) {
      setData(null)
      return
    }
    const epoch = ++epochRef.current
    setLoading(true)
    setError(null)
    try {
      const selector = contextKind === 'team' ? { teamId: ownerId } : { botId: ownerId }
      const res = await bridge.listWorkspaceOutput({ ...selector, limit: 120 })
      if (epochRef.current !== epoch) return
      setData(res)
    } catch (err) {
      if (epochRef.current !== epoch) return
      setError(err instanceof Error ? err.message : 'Failed to load execution output.')
    } finally {
      if (epochRef.current === epoch) {
        setLoading(false)
      }
    }
  }, [bridge, contextKind, ownerId, supported])

  useEffect(() => {
    setRunFilter('all')
    setSourceFilter('all')
    setSeverityFilter('all')
    setSearchQuery('')
    setClearedAt(null)
    void loadOutput()
  }, [contextKey, loadOutput])

  const hasRunning = Boolean(data?.runs.some((r) => r.status === 'running'))
  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => {
      void loadOutput()
    }, 1500)
    return () => clearInterval(timer)
  }, [hasRunning, loadOutput])

  const filteredEntries = useMemo(() => {
    if (!data) return []
    const needle = searchQuery.trim().toLowerCase()
    return data.entries.filter((entry) => {
      if (clearedAt && entry.timestamp <= clearedAt) return false
      if (runFilter !== 'all' && entry.runId !== runFilter) return false
      if (sourceFilter !== 'all' && entry.source !== sourceFilter) return false
      if (severityFilter !== 'all' && entry.severity !== severityFilter) return false
      if (
        needle &&
        !entry.title.toLowerCase().includes(needle) &&
        !entry.message.toLowerCase().includes(needle)
      ) {
        return false
      }
      return true
    })
  }, [clearedAt, data, runFilter, searchQuery, severityFilter, sourceFilter])

  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight
    }
  }, [autoScroll, filteredEntries.length])

  if (!supported || !bridge || !ownerId) {
    return (
      <section className="gb-workspace-placeholder" data-testid="workspace-output-unavailable">
        <div className="gb-workspace-placeholder-head">
          <strong style={{ fontSize: '13px' }}>Output</strong>
          <span className="gb-badge">Unavailable</span>
        </div>
        <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
          Execution output requires an active authorized bot/team and daemon IPC bridge.
          {isMockMode ? ' (Mock mode)' : ''}
        </p>
      </section>
    )
  }

  const handleCopy = async () => {
    const text = filteredEntries
      .map(
        (e) =>
          `[${e.timestamp}] [${e.source}] [${e.status}] ${e.title}${
            e.exitCode !== null ? ` (exit ${e.exitCode})` : ''
          }\n${e.message}`,
      )
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Clipboard copy unavailable.')
    }
  }

  const handleCancel = async (entry: WorkspaceOutputEntry) => {
    if (!ownerId || contextKind !== 'bot') return
    setError(null)
    try {
      await bridge.cancelWorkspaceOutput({
        botId: ownerId,
        runId: entry.runId,
        terminalCommandId:
          entry.source === 'terminal' || entry.source === 'build'
            ? entry.taskId ?? undefined
            : undefined,
      })
      await loadOutput()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancellation failed.')
    }
  }

  return (
    <div className="gb-output-tab" data-testid="workspace-output-tab">
      <div className="gb-output-controls">
        <div className="gb-output-filter-row">
          <select
            className="gb-output-select"
            aria-label="Filter by run"
            data-testid="output-run-filter"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
          >
            <option value="all">All runs</option>
            {(data?.runs ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 8)} · {r.status}
              </option>
            ))}
          </select>

          <select
            className="gb-output-select"
            aria-label="Filter by source"
            data-testid="output-source-filter"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">All sources</option>
            <option value="run">Run</option>
            <option value="tool">Tool</option>
            <option value="terminal">Terminal</option>
            <option value="build">Build/Test</option>
          </select>

          <select
            className="gb-output-select"
            aria-label="Filter by severity"
            data-testid="output-severity-filter"
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
          >
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </div>

        <div className="gb-output-filter-row">
          <input
            type="search"
            className="gb-output-search"
            aria-label="Search execution output"
            data-testid="output-search-input"
            placeholder="Filter output..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className="gb-workspace-icon-btn"
            aria-pressed={autoScroll}
            onClick={() => setAutoScroll((prev) => !prev)}
            data-testid="output-autoscroll-btn"
          >
            {autoScroll ? 'Auto' : 'Manual'}
          </button>
          <button
            type="button"
            className="gb-workspace-icon-btn"
            onClick={() => void handleCopy()}
            disabled={filteredEntries.length === 0}
            data-testid="output-copy-btn"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="gb-workspace-icon-btn"
            onClick={() => setClearedAt(new Date().toISOString())}
            data-testid="output-clear-btn"
          >
            Clear
          </button>
          <button
            type="button"
            className="gb-workspace-icon-btn"
            onClick={() => {
              setClearedAt(null)
              void loadOutput()
            }}
            data-testid="output-refresh-btn"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="gb-browser-error" role="alert" data-testid="output-error-banner">
          {error}
        </div>
      )}

      {data && !data.authorized && (
        <div className="gb-browser-error" role="alert" data-testid="output-unauthorized-banner">
          {data.reason ?? 'Execution output is unauthorized.'}
        </div>
      )}

      {data?.authorized && data.reason && (
        <div className="gb-muted" style={{ fontSize: 12 }} data-testid="output-policy-note">
          {data.reason}
        </div>
      )}

      {data?.truncated && (
        <div className="gb-muted" style={{ fontSize: 11.5 }}>
          Showing the latest {data.entries.length} bounded events.
        </div>
      )}

      <div ref={streamRef} className="gb-output-stream" data-testid="output-stream">
        {loading && !data ? (
          <span className="gb-muted" style={{ fontSize: 12 }}>
            Loading execution output...
          </span>
        ) : filteredEntries.length === 0 ? (
          <span className="gb-muted" style={{ fontSize: 12 }} data-testid="output-empty-state">
            No execution output recorded for this context.
          </span>
        ) : (
          filteredEntries.map((entry) => (
            <article
              key={entry.id}
              className="gb-output-entry"
              data-testid={`output-entry-${entry.id}`}
            >
              <div className="gb-output-entry-head">
                <div className="gb-output-entry-meta">
                  <span className="gb-badge">{entry.source}</span>
                  <span className="gb-badge">{entry.status}</span>
                  {entry.exitCode !== null && (
                    <span className="gb-badge">exit {entry.exitCode}</span>
                  )}
                  {entry.durationMs !== null && (
                    <span className="gb-muted">{entry.durationMs}ms</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="gb-muted" style={{ fontSize: 11 }}>
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  {entry.cancellable && contextKind === 'bot' && (
                    <button
                      type="button"
                      className="gb-workspace-icon-btn"
                      onClick={() => void handleCancel(entry)}
                      data-testid={`output-cancel-${entry.runId}`}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              <strong style={{ fontSize: 12 }}>{entry.title}</strong>
              <pre className="gb-output-pre">{entry.message}</pre>
            </article>
          ))
        )}
      </div>
    </div>
  )
}
