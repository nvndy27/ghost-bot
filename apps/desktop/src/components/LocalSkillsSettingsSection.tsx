import { useCallback, useEffect, useState } from 'react'
import type { LocalSkillDto } from '@ghost-bot/shared-types/ipc'

function requireBridge() {
  const bridge = window.ghostBot
  if (!bridge) {
    throw new Error('Desktop IPC bridge is unavailable.')
  }
  return bridge
}

export function LocalSkillsSettingsSection() {
  const [skills, setSkills] = useState<LocalSkillDto[]>([])
  const [rootInput, setRootInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      const res = await bridge.listLocalSkills()
      setSkills(res.skills)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load local skills')
    }
  }, [])

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const handleDiscover = async () => {
    const trimmed = rootInput.trim()
    if (!trimmed) {
      setError('Enter an authorized skill root directory path.')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await requireBridge().discoverLocalSkills({ roots: [trimmed] })
      setNotice(`Discovered ${res.skills.length} skill(s) from ${trimmed}.`)
      await loadSkills()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discover local skills')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="local-skills-section" style={{ marginTop: '20px' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: '15px' }}>Local Skills Registry</h3>
      <p className="gb-muted" style={{ margin: '0 0 10px', fontSize: '12.5px' }}>
        Read-only discovery of local <code>SKILL.md</code> manifests. Skills are untrusted data, pinned by SHA-256 content fingerprint, and never grant terminal, MCP, credential, or network permissions.
      </p>

      {error && (
        <div
          role="alert"
          data-testid="skills-error-banner"
          style={{
            padding: '8px 10px',
            marginBottom: '8px',
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
          data-testid="skills-notice-banner"
          style={{
            padding: '8px 10px',
            marginBottom: '8px',
            borderRadius: '6px',
            border: '1px solid var(--gb-border)',
            fontSize: '12.5px',
          }}
        >
          {notice}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <input
          className="gb-input"
          data-testid="skills-root-input"
          value={rootInput}
          onChange={(e) => setRootInput(e.target.value)}
          placeholder="/path/to/authorized/skills"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="gb-btn gb-btn-primary"
          data-testid="skills-discover-btn"
          disabled={busy}
          onClick={() => void handleDiscover()}
        >
          Discover Skills
        </button>
      </div>

      {skills.length === 0 ? (
        <p className="gb-muted" style={{ fontSize: '12.5px' }}>
          No local skills discovered yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {skills.map((skill) => {
            const changedSinceTrust =
              skill.trustedFingerprint !== null &&
              skill.trustedFingerprint !== skill.contentFingerprint
            return (
              <div
                key={skill.id}
                data-testid={`skill-card-${skill.name}`}
                style={{
                  border: '1px solid var(--gb-border)',
                  borderRadius: '8px',
                  padding: '10px 12px',
                  fontSize: '12.5px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <div>
                    <strong>{skill.name}</strong>{' '}
                    <span className="gb-badge">{skill.trustState}</span>{' '}
                    <span className="gb-badge">{skill.enabled ? 'enabled' : 'disabled'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    {skill.trustState !== 'trusted' ? (
                      <button
                        type="button"
                        className="gb-btn"
                        data-testid={`skill-trust-${skill.name}`}
                        disabled={busy || skill.trustState === 'invalid'}
                        onClick={() =>
                          void requireBridge()
                            .approveLocalSkillTrust(skill.id)
                            .then(() => loadSkills())
                            .catch((err) => setError(err instanceof Error ? err.message : 'Trust failed'))
                        }
                      >
                        Trust
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="gb-btn"
                        data-testid={`skill-revoke-${skill.name}`}
                        disabled={busy}
                        onClick={() =>
                          void requireBridge()
                            .revokeLocalSkillTrust(skill.id)
                            .then(() => loadSkills())
                            .catch((err) => setError(err instanceof Error ? err.message : 'Revoke failed'))
                        }
                      >
                        Revoke
                      </button>
                    )}
                    <button
                      type="button"
                      className="gb-btn"
                      data-testid={`skill-toggle-${skill.name}`}
                      disabled={busy || skill.trustState !== 'trusted'}
                      onClick={() =>
                        void requireBridge()
                          .setLocalSkillEnabled({ skillId: skill.id, enabled: !skill.enabled })
                          .then(() => loadSkills())
                          .catch((err) => setError(err instanceof Error ? err.message : 'Toggle failed'))
                      }
                    >
                      {skill.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
                {skill.description && (
                  <div className="gb-muted" style={{ marginTop: '4px' }}>
                    {skill.description}
                  </div>
                )}
                <div className="gb-muted" style={{ fontSize: '11.5px', marginTop: '4px', fontFamily: 'monospace' }}>
                  {skill.sourcePath} · sha256:{skill.contentFingerprint.slice(0, 16)}…
                </div>
                {changedSinceTrust && (
                  <div style={{ color: '#d9534f', fontSize: '12px', marginTop: '4px' }}>
                    Warning: Skill content changed since last trust approval; trust revoked.
                  </div>
                )}
                {skill.validationError && (
                  <div style={{ color: '#d9534f', fontSize: '12px', marginTop: '4px' }}>
                    Validation error: {skill.validationError}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
