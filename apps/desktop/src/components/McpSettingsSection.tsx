import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AppSettingsPatch,
  McpCapabilitySnapshotDto,
  McpScopeInput,
  McpServerDto,
} from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

export interface McpSettingsSectionProps {
  settings: AppSettings
  bots: WorkspaceBot[]
  activeBotId?: string | null
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
}

function requireBridge() {
  const bridge = window.ghostBot
  if (!bridge) {
    throw new Error('Desktop IPC bridge is unavailable in browser-only mode.')
  }
  return bridge
}

export function McpSettingsSection({
  settings,
  bots,
  activeBotId,
  onUpdateSettings,
}: McpSettingsSectionProps) {
  const defaultBotId =
    activeBotId && bots.some((b) => b.id === activeBotId)
      ? activeBotId
      : (bots[0]?.id ?? '')

  const [servers, setServers] = useState<McpServerDto[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [scopeKind, setScopeKind] = useState<'user' | 'bot' | 'workspace'>('bot')
  const [botId, setBotId] = useState(defaultBotId)
  const [workspacePath, setWorkspacePath] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [executablePath, setExecutablePath] = useState('')
  const [argsText, setArgsText] = useState('')
  const [cwd, setCwd] = useState('')
  const [envAllowlistText, setEnvAllowlistText] = useState('')

  const [selectedCaps, setSelectedCaps] = useState<McpCapabilitySnapshotDto | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const loadSeqRef = useRef(0)
  const capsSeqRef = useRef(0)

  useEffect(() => {
    if (!botId && defaultBotId) {
      setBotId(defaultBotId)
    }
  }, [botId, defaultBotId])

  const loadServers = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError(null)
    try {
      const res = await bridge.listMcpServers({ includeUserWide: true, limit: 100 })
      if (seq !== loadSeqRef.current) return
      setServers(res.servers)
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load MCP servers')
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  const handleToggleMcp = async (enabled: boolean) => {
    setError(null)
    setNotice(null)
    try {
      await onUpdateSettings({ mcp: { enabled } })
      setNotice(enabled ? 'MCP tools enabled' : 'MCP tools disabled')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update MCP setting')
    }
  }

  const handleRegister = async () => {
    setError(null)
    setNotice(null)
    const trimmedName = displayName.trim()
    const trimmedExec = executablePath.trim()
    const trimmedCwd = cwd.trim()
    if (!trimmedName || !trimmedExec || !trimmedCwd) {
      setError('Display name, executable path, and working directory are required.')
      return
    }
    let scope: McpScopeInput
    if (scopeKind === 'user') {
      scope = { kind: 'user' }
    } else if (scopeKind === 'bot') {
      if (!botId) {
        setError('Select a bot for bot-scoped MCP server.')
        return
      }
      scope = { kind: 'bot', botId }
    } else {
      if (!workspacePath.trim()) {
        setError('Workspace path is required for workspace-scoped MCP server.')
        return
      }
      scope = { kind: 'workspace', workspacePath: workspacePath.trim() }
    }

    const args = argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const envAllowlist = envAllowlistText
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)

    setBusyId('register')
    try {
      const created = await requireBridge().registerMcpServer({
        scope,
        displayName: trimmedName,
        description: '',
        transport: {
          type: 'stdio',
          executablePath: trimmedExec,
          args,
          cwd: trimmedCwd,
          envAllowlist,
          secretRefs: [],
        },
      })
      setDisplayName('')
      setExecutablePath('')
      setArgsText('')
      setCwd('')
      setEnvAllowlistText('')
      setNotice(`Registered "${created.displayName}" (untrusted until approved).`)
      await loadServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register MCP server')
    } finally {
      setBusyId(null)
    }
  }

  const runServerAction = async (id: string, action: () => Promise<void>, successMsg?: string) => {
    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (successMsg) setNotice(successMsg)
      await loadServers()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'MCP action failed')
    } finally {
      setBusyId(null)
    }
  }

  const handleInspectCapabilities = async (id: string) => {
    const seq = ++capsSeqRef.current
    setBusyId(id)
    setError(null)
    setPreviewText(null)
    try {
      const caps = await requireBridge().getMcpCapabilities(id)
      if (seq !== capsSeqRef.current) return
      setSelectedCaps(caps)
      if (!caps) {
        setNotice('Connect the server first to discover tools, resources, and prompts.')
      }
    } catch (err) {
      if (seq !== capsSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to inspect MCP capabilities')
    } finally {
      if (seq === capsSeqRef.current) setBusyId(null)
    }
  }

  return (
    <div data-testid="mcp-settings-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '17px' }}>Tools &amp; MCP</h2>
          <p className="gb-muted" style={{ margin: '4px 0 0', fontSize: '13px' }}>
            Local STDIO MCP servers run unsandboxed with your OS user privileges, require explicit trust + binary digest pinning, and are permitted only in Ask Approval mode (blocked in Read-Only, Workspace, and Full Access; native Codex MCP remains disabled).
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 500 }}>
          <input
            type="checkbox"
            data-testid="mcp-enabled-toggle"
            checked={settings.mcp.enabled}
            onChange={(e) => void handleToggleMcp(e.target.checked)}
          />
          Enable MCP
        </label>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="mcp-error-banner"
          style={{
            padding: '8px 10px',
            marginBottom: '10px',
            borderRadius: '6px',
            border: '1px solid #d9534f',
            fontSize: '12.5px',
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          data-testid="mcp-notice-banner"
          style={{
            padding: '8px 10px',
            marginBottom: '10px',
            borderRadius: '6px',
            border: '1px solid var(--gb-border)',
            fontSize: '12.5px',
          }}
        >
          {notice}
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--gb-border)',
          borderRadius: '8px',
          padding: '12px',
          marginBottom: '14px',
        }}
      >
        <div style={{ fontWeight: 600, fontSize: '13.5px', marginBottom: '8px' }}>
          Register Local STDIO Server
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <label style={{ fontSize: '12px' }}>
            Scope
            <select
              className="gb-input"
              data-testid="mcp-scope-select"
              value={scopeKind}
              onChange={(e) => setScopeKind(e.target.value as 'user' | 'bot' | 'workspace')}
              style={{ width: '100%', marginTop: '4px' }}
            >
              <option value="bot">Bot-scoped</option>
              <option value="workspace">Workspace-scoped</option>
              <option value="user">User-wide</option>
            </select>
          </label>
          {scopeKind === 'bot' && (
            <label style={{ fontSize: '12px' }}>
              Bot
              <select
                className="gb-input"
                data-testid="mcp-bot-select"
                value={botId}
                onChange={(e) => setBotId(e.target.value)}
                style={{ width: '100%', marginTop: '4px' }}
              >
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.permission})
                  </option>
                ))}
              </select>
            </label>
          )}
          {scopeKind === 'workspace' && (
            <label style={{ fontSize: '12px' }}>
              Workspace path
              <input
                className="gb-input"
                data-testid="mcp-workspace-input"
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                placeholder="/path/to/workspace"
                style={{ width: '100%', marginTop: '4px' }}
              />
            </label>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <label style={{ fontSize: '12px' }}>
            Display name
            <input
              className="gb-input"
              data-testid="mcp-name-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Local Workspace Tools"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label style={{ fontSize: '12px' }}>
            Executable path
            <input
              className="gb-input"
              data-testid="mcp-exec-input"
              value={executablePath}
              onChange={(e) => setExecutablePath(e.target.value)}
              placeholder="/usr/bin/node"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <label style={{ fontSize: '12px' }}>
            Working directory (cwd)
            <input
              className="gb-input"
              data-testid="mcp-cwd-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/server"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
          <label style={{ fontSize: '12px' }}>
            Env allowlist (comma-separated)
            <input
              className="gb-input"
              data-testid="mcp-env-input"
              value={envAllowlistText}
              onChange={(e) => setEnvAllowlistText(e.target.value)}
              placeholder="NODE_ENV"
              style={{ width: '100%', marginTop: '4px' }}
            />
          </label>
        </div>

        <label style={{ display: 'block', fontSize: '12px', marginBottom: '8px' }}>
          Arguments (one per line)
          <textarea
            className="gb-input"
            data-testid="mcp-args-input"
            rows={2}
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            placeholder="/path/to/server.mjs"
            style={{ width: '100%', marginTop: '4px', fontFamily: 'monospace', fontSize: '12px' }}
          />
        </label>

        <button
          type="button"
          className="gb-btn gb-btn-primary"
          data-testid="mcp-register-btn"
          disabled={busyId === 'register'}
          onClick={() => void handleRegister()}
        >
          {busyId === 'register' ? 'Registering…' : 'Register Server'}
        </button>
      </div>

      <div style={{ fontWeight: 600, fontSize: '13.5px', marginBottom: '8px' }}>
        Configured Servers ({servers.length}) {loading ? '· Loading…' : ''}
      </div>

      {servers.length === 0 ? (
        <p className="gb-muted" style={{ fontSize: '13px' }}>
          No MCP servers registered yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {servers.map((srv) => (
            <div
              key={srv.id}
              data-testid={`mcp-server-${srv.id}`}
              style={{
                border: '1px solid var(--gb-border)',
                borderRadius: '8px',
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                <div>
                  <strong style={{ fontSize: '13.5px' }}>{srv.displayName}</strong>{' '}
                  <span className="gb-badge">{srv.scope.kind}</span>{' '}
                  <span className="gb-badge" data-testid={`mcp-trust-${srv.id}`}>
                    {srv.trustState}
                  </span>{' '}
                  <span className="gb-badge">{srv.enabled ? 'enabled' : 'disabled'}</span>{' '}
                  <span className="gb-badge" data-testid={`mcp-conn-${srv.id}`}>
                    {srv.connectionState ?? 'disconnected'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {srv.trustState !== 'trusted' ? (
                    <button
                      type="button"
                      className="gb-btn"
                      data-testid={`mcp-approve-trust-${srv.id}`}
                      disabled={busyId === srv.id}
                      onClick={() =>
                        void runServerAction(
                          srv.id,
                          async () => {
                            await requireBridge().approveMcpTrust(srv.id)
                          },
                          `Trusted "${srv.displayName}".`,
                        )
                      }
                    >
                      Approve Trust
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="gb-btn"
                      data-testid={`mcp-revoke-trust-${srv.id}`}
                      disabled={busyId === srv.id}
                      onClick={() =>
                        void runServerAction(
                          srv.id,
                          async () => {
                            await requireBridge().revokeMcpTrust(srv.id)
                            if (selectedCaps?.serverId === srv.id) setSelectedCaps(null)
                          },
                          `Revoked trust for "${srv.displayName}".`,
                        )
                      }
                    >
                      Revoke Trust
                    </button>
                  )}

                  {srv.trustState === 'trusted' && (
                    <button
                      type="button"
                      className="gb-btn"
                      data-testid={`mcp-toggle-enabled-${srv.id}`}
                      disabled={busyId === srv.id}
                      onClick={() =>
                        void runServerAction(srv.id, async () => {
                          await requireBridge().setMcpServerEnabled({
                            id: srv.id,
                            enabled: !srv.enabled,
                          })
                        })
                      }
                    >
                      {srv.enabled ? 'Disable' : 'Enable'}
                    </button>
                  )}

                  {srv.enabled && srv.trustState === 'trusted' && srv.connectionState !== 'ready' && (
                    <button
                      type="button"
                      className="gb-btn"
                      data-testid={`mcp-connect-${srv.id}`}
                      disabled={busyId === srv.id || !settings.mcp.enabled}
                      onClick={() =>
                        void runServerAction(
                          srv.id,
                          async () => {
                            await requireBridge().connectMcpServer(srv.id)
                            const caps = await requireBridge().getMcpCapabilities(srv.id)
                            setSelectedCaps(caps)
                          },
                          `Connected to "${srv.displayName}".`,
                        )
                      }
                    >
                      Connect
                    </button>
                  )}

                  {srv.connectionState === 'ready' && (
                    <>
                      <button
                        type="button"
                        className="gb-btn"
                        data-testid={`mcp-caps-${srv.id}`}
                        disabled={busyId === srv.id}
                        onClick={() => void handleInspectCapabilities(srv.id)}
                      >
                        Capabilities
                      </button>
                      <button
                        type="button"
                        className="gb-btn"
                        data-testid={`mcp-disconnect-${srv.id}`}
                        disabled={busyId === srv.id}
                        onClick={() =>
                          void runServerAction(srv.id, async () => {
                            await requireBridge().disconnectMcpServer(srv.id)
                            if (selectedCaps?.serverId === srv.id) setSelectedCaps(null)
                          })
                        }
                      >
                        Disconnect
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    className="gb-btn"
                    data-testid={`mcp-delete-${srv.id}`}
                    disabled={busyId === srv.id}
                    onClick={() =>
                      void runServerAction(
                        srv.id,
                        async () => {
                          await requireBridge().deleteMcpServer(srv.id)
                          if (selectedCaps?.serverId === srv.id) setSelectedCaps(null)
                        },
                        `Deleted "${srv.displayName}".`,
                      )
                    }
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="gb-muted" style={{ fontSize: '12px', marginTop: '4px', fontFamily: 'monospace' }}>
                {srv.transport.executablePath} {srv.transport.args.join(' ')} (cwd: {srv.transport.cwd})
              </div>
              {srv.trustedBinaryDigest && (
                <div className="gb-muted" style={{ fontSize: '11.5px', marginTop: '2px', fontFamily: 'monospace' }}>
                  Pinned digest: {srv.trustedBinaryDigest.slice(0, 16)}…
                </div>
              )}
              {srv.lastError && (
                <div style={{ color: '#d9534f', fontSize: '12px', marginTop: '4px' }}>
                  Error: {srv.lastError}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {selectedCaps && (
        <div
          data-testid="mcp-capabilities-panel"
          style={{
            marginTop: '14px',
            border: '1px solid var(--gb-border)',
            borderRadius: '8px',
            padding: '12px',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: '13.5px', marginBottom: '6px' }}>
            Discovered Capabilities ({selectedCaps.serverId})
          </div>
          <div style={{ fontSize: '12.5px', marginBottom: '6px' }}>
            <strong>Tools ({selectedCaps.tools.length}):</strong>{' '}
            {selectedCaps.tools.map((t) => `${t.name} [${t.definitionHash.slice(0, 8)}]`).join(', ') || 'None'}
          </div>
          <div style={{ fontSize: '12.5px', marginBottom: '6px' }}>
            <strong>Resources ({selectedCaps.resources.length}):</strong>{' '}
            {selectedCaps.resources.map((r) => (
              <button
                key={r.capabilityKey}
                type="button"
                className="gb-btn"
                style={{ marginLeft: '6px', fontSize: '11.5px', padding: '2px 6px' }}
                onClick={() =>
                  void requireBridge()
                    .readMcpResource({ serverId: selectedCaps.serverId, uri: r.uri })
                    .then((res) =>
                      setPreviewText(
                        res.contents.map((c) => c.text ?? `[binary ${c.mimeType ?? ''}]`).join('\n'),
                      ),
                    )
                    .catch((err) => setError(err instanceof Error ? err.message : 'Failed to read resource'))
                }
              >
                Read {r.name}
              </button>
            ))}
            {selectedCaps.resources.length === 0 && 'None'}
          </div>
          <div style={{ fontSize: '12.5px' }}>
            <strong>Prompts ({selectedCaps.prompts.length}):</strong>{' '}
            {selectedCaps.prompts.map((p) => (
              <button
                key={p.capabilityKey}
                type="button"
                className="gb-btn"
                style={{ marginLeft: '6px', fontSize: '11.5px', padding: '2px 6px' }}
                onClick={() =>
                  void requireBridge()
                    .getMcpPrompt({ serverId: selectedCaps.serverId, name: p.name })
                    .then((res) =>
                      setPreviewText(
                        res.messages.map((m) => `${m.role}: ${m.content.text ?? ''}`).join('\n'),
                      ),
                    )
                    .catch((err) => setError(err instanceof Error ? err.message : 'Failed to get prompt'))
                }
              >
                Preview {p.name}
              </button>
            ))}
            {selectedCaps.prompts.length === 0 && 'None'}
          </div>
          {previewText !== null && (
            <pre
              data-testid="mcp-capability-preview"
              style={{
                marginTop: '8px',
                padding: '8px',
                borderRadius: '6px',
                border: '1px solid var(--gb-border)',
                fontSize: '12px',
                whiteSpace: 'pre-wrap',
                maxHeight: '160px',
                overflow: 'auto',
              }}
            >
              {previewText}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
