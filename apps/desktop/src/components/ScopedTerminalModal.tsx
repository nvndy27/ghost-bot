import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TerminalCapabilitiesDto,
  TerminalCommandDto,
} from '@ghost-bot/shared-types/ipc'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { WorkspaceBot } from '../types/workspace.ts'

export interface ScopedTerminalModalProps {
  open: boolean
  bots: WorkspaceBot[]
  activeBotId: string | null
  onClose: () => void
}

function requireBridge() {
  const bridge = window.ghostBot
  if (!bridge) {
    throw new Error('Desktop IPC bridge is unavailable.')
  }
  return bridge
}

export function ScopedTerminalModal({
  open,
  bots,
  activeBotId,
  onClose,
}: ScopedTerminalModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null)
  useModalDialog(open, modalRef, onClose)

  const defaultBot = bots.find((b) => b.id === activeBotId) ?? bots[0] ?? null
  const [selectedBotId, setSelectedBotId] = useState(defaultBot?.id ?? '')
  const [capabilities, setCapabilities] = useState<TerminalCapabilitiesDto | null>(null)
  const [commands, setCommands] = useState<TerminalCommandDto[]>([])
  const [executable, setExecutable] = useState('/bin/echo')
  const [argsText, setArgsText] = useState('hello-scoped-workspace')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedBot = bots.find((b) => b.id === selectedBotId) ?? defaultBot

  useEffect(() => {
    if (!selectedBotId && defaultBot?.id) {
      setSelectedBotId(defaultBot.id)
    }
  }, [selectedBotId, defaultBot?.id])

  const refresh = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge || !open) return
    try {
      const [caps, list] = await Promise.all([
        bridge.getTerminalCapabilities(),
        bridge.listTerminalCommands({
          ...(selectedBot?.id ? { botId: selectedBot.id } : {}),
          limit: 25,
        }),
      ])
      setCapabilities(caps)
      setCommands(list.commands)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scoped terminal state')
    }
  }, [open, selectedBot?.id])

  useEffect(() => {
    if (!open) return
    setError(null)
    void refresh()
  }, [open, refresh])

  if (!open) return null

  const handleRequestApproval = async () => {
    if (!selectedBot) {
      setError('Select a bot first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const args = argsText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
      await requireBridge().requestTerminalCommand({
        botId: selectedBot.id,
        executable: executable.trim(),
        args,
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request command approval')
    } finally {
      setBusy(false)
    }
  }

  const handleResolve = async (commandId: string, decision: 'approved' | 'denied', commandHash: string) => {
    setBusy(true)
    setError(null)
    try {
      await requireBridge().resolveTerminalCommand({
        commandId,
        decision,
        expectedCommandHash: commandHash,
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${decision} command`)
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async (commandId: string) => {
    setBusy(true)
    setError(null)
    try {
      await requireBridge().cancelTerminalCommand(commandId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop command')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Scoped Terminal">
      <div
        ref={modalRef}
        tabIndex={-1}
        className="gb-modal"
        style={{ width: 'min(920px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
      >
        <div className="gb-modal-head">
          <div>
            <strong>Ghost Bot Scoped Terminal</strong>{' '}
            <span className="gb-badge">
              {capabilities?.bubblewrapAvailable ? 'Bubblewrap isolated' : 'Sandbox unavailable'}
            </span>{' '}
            <span className="gb-badge">Non-interactive · PTY disabled</span>
          </div>
          <button type="button" className="gb-btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div style={{ padding: '12px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <p className="gb-muted" style={{ margin: 0, fontSize: '12px' }}>
            Ghost Bot-owned scoped command execution (separate from provider-native Codex terminal tools). Commands run in Bubblewrap with <code>--unshare-all</code>, read-only system mounts, no host <code>$HOME</code>/keyring/DBus, and no network access.
          </p>

          {selectedBot && (
            <div
              data-testid="terminal-workspace-indicator"
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid var(--gb-border)',
                fontSize: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span>
                <strong>Authorized Workspace:</strong> <code>{selectedBot.workspacePath}</code>
              </span>
              <span>
                <strong>Permission Mode:</strong>{' '}
                <span className="gb-badge">{selectedBot.permission}</span>
              </span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              data-testid="terminal-error-banner"
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                border: '1px solid #d9534f',
                fontSize: '12.5px',
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              border: '1px solid var(--gb-border)',
              borderRadius: '8px',
              padding: '10px 12px',
              display: 'grid',
              gap: '8px',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <label style={{ fontSize: '12px' }}>
                Target Bot
                <select
                  className="gb-input"
                  data-testid="terminal-bot-select"
                  value={selectedBot?.id ?? ''}
                  onChange={(e) => setSelectedBotId(e.target.value)}
                  style={{ width: '100%', marginTop: '4px' }}
                >
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.permission})
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: '12px' }}>
                Executable
                <input
                  className="gb-input"
                  data-testid="terminal-exec-input"
                  value={executable}
                  onChange={(e) => setExecutable(e.target.value)}
                  style={{ width: '100%', marginTop: '4px', fontFamily: 'monospace' }}
                />
              </label>
            </div>
            <label style={{ fontSize: '12px' }}>
              Arguments (one per line, no shell interpolation)
              <textarea
                className="gb-input"
                data-testid="terminal-args-input"
                rows={2}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                style={{ width: '100%', marginTop: '4px', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </label>
            <div>
              <button
                type="button"
                className="gb-btn gb-btn-primary"
                data-testid="terminal-request-btn"
                disabled={busy || !capabilities?.bubblewrapAvailable}
                onClick={() => void handleRequestApproval()}
              >
                Request Command Approval
              </button>
            </div>
          </div>

          <div style={{ fontWeight: 600, fontSize: '13px' }}>
            Command History &amp; Approvals ({commands.length})
          </div>
          {commands.length === 0 ? (
            <p className="gb-muted" style={{ fontSize: '12.5px', margin: 0 }}>
              No scoped commands requested yet.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {commands.map((cmd) => (
                <div
                  key={cmd.id}
                  data-testid={`terminal-cmd-${cmd.id}`}
                  style={{
                    border: '1px solid var(--gb-border)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    fontSize: '12px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div>
                      <code>
                        {cmd.executable} {cmd.args.join(' ')}
                      </code>{' '}
                      <span className="gb-badge">{cmd.status}</span>{' '}
                      {cmd.exitCode !== null && <span className="gb-badge">exit {cmd.exitCode}</span>}
                      {cmd.timedOut && <span className="gb-badge">timed out</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {cmd.status === 'awaiting_approval' && (
                        <>
                          <button
                            type="button"
                            className="gb-btn gb-btn-primary"
                            data-testid={`terminal-approve-${cmd.id}`}
                            disabled={busy}
                            onClick={() => void handleResolve(cmd.id, 'approved', cmd.commandHash)}
                          >
                            Approve once
                          </button>
                          <button
                            type="button"
                            className="gb-btn"
                            data-testid={`terminal-deny-${cmd.id}`}
                            disabled={busy}
                            onClick={() => void handleResolve(cmd.id, 'denied', cmd.commandHash)}
                          >
                            Deny
                          </button>
                        </>
                      )}
                      {cmd.status === 'running' && (
                        <button
                          type="button"
                          className="gb-btn"
                          data-testid={`terminal-stop-${cmd.id}`}
                          disabled={busy}
                          onClick={() => void handleCancel(cmd.id)}
                        >
                          Stop Execution
                        </button>
                      )}
                    </div>
                  </div>
                  {(cmd.status === 'uncertain' || cmd.terminationConfirmed === false) && (
                    <div style={{ color: '#d9534f', marginTop: '4px' }}>
                      Warning: Process termination could not be confirmed; automatic replay is disabled.
                    </div>
                  )}
                  <div className="gb-muted" style={{ fontSize: '11px', marginTop: '4px' }}>
                    Hash: <code>{cmd.commandHash.slice(0, 16)}…</code> · Workspace: <code>{cmd.canonicalWorkspace}</code>
                  </div>
                  {(cmd.stdoutPreview || cmd.stderrPreview) && (
                    <pre
                      style={{
                        marginTop: '6px',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        background: 'var(--gb-surface-2, rgba(128,128,128,0.1))',
                        maxHeight: '140px',
                        overflow: 'auto',
                        fontSize: '11.5px',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {cmd.stdoutPreview}
                      {cmd.stderrPreview ? `\n[stderr]\n${cmd.stderrPreview}` : ''}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
