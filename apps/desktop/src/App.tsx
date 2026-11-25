import { useEffect, useState } from 'react'
import type {
  AppInfoResponse,
  DaemonHealthResponse,
  GhostBotBridge,
  ProviderSummary,
} from '@ghost-bot/shared-types/ipc'

declare global {
  interface Window {
    ghostBot?: GhostBotBridge
  }
}

export function App() {
  const [appInfo, setAppInfo] = useState<AppInfoResponse | null>(null)
  const [health, setHealth] = useState<DaemonHealthResponse | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const bridge = window.ghostBot
    if (!bridge) {
      setError('Preload bridge unavailable (running outside Electron).')
      return
    }
    void Promise.all([
      bridge.getAppInfo(),
      bridge.getDaemonHealth(),
      bridge.listProviders(),
    ])
      .then(([info, daemonHealth, providerList]) => {
        setAppInfo(info)
        setHealth(daemonHealth)
        setProviders(providerList)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load daemon state')
      })
  }, [])

  return (
    <main
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: '100vh',
        padding: '24px',
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: '520px',
          background: 'var(--gb-surface)',
          border: '1px solid var(--gb-border)',
          borderRadius: 'var(--gb-radius-md)',
          padding: '20px',
        }}
      >
        <h1 style={{ margin: '0 0 8px', fontSize: '18px' }}>Ghost Bot — Phase 1A Foundation</h1>
        <p style={{ margin: '0 0 16px', color: 'var(--gb-muted)' }}>
          Sandboxed Electron shell, restricted preload IPC, and authenticated local daemon.
        </p>

        {error && (
          <p role="alert" style={{ color: '#e58b8b', margin: '0 0 12px' }}>
            {error}
          </p>
        )}

        {appInfo && health && (
          <div style={{ display: 'grid', gap: '8px', fontSize: '13px' }}>
            <div>
              <strong>App:</strong> {appInfo.name} v{appInfo.version} ({appInfo.platform}/{appInfo.arch}, sandbox:{' '}
              {String(appInfo.sandboxed)})
            </div>
            <div>
              <strong>Daemon:</strong> pid {health.pid}, mode <code>{health.runtimeMode}</code>, ok:{' '}
              {String(health.ok)}
            </div>
            <div>
              <strong>Providers:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px', color: 'var(--gb-muted)' }}>
                {providers.map((p) => (
                  <li key={p.id}>
                    {p.label} — <code>{p.status}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
