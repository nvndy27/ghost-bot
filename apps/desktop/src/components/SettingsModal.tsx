import { useRef, useState } from 'react'
import { avatarPresets } from '@ghost-bot/avatar/presets'
import type { ProviderSummary } from '@ghost-bot/shared-types/ipc'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { AvatarStatus, ThemePreference, UiPreferences } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'accounts', label: 'Accounts & Providers' },
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage' },
  { id: 'personalization', label: 'Personalization' },
  { id: 'memory', label: 'Memory' },
  { id: 'tools', label: 'Tools & MCP' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'computer-use', label: 'Computer Use' },
  { id: 'routines', label: 'Routines' },
  { id: 'privacy', label: 'Data & Privacy' },
  { id: 'advanced', label: 'Advanced' },
] as const

type SectionId = (typeof SETTINGS_SECTIONS)[number]['id']

const AVATAR_STATES: AvatarStatus[] = [
  'idle',
  'thinking',
  'working',
  'approval',
  'sleeping',
  'completed',
  'error',
]

export interface SettingsModalProps {
  open: boolean
  preferences: UiPreferences
  providers: ProviderSummary[]
  onUpdatePreferences: (patch: Partial<UiPreferences>) => void
  onClose: () => void
}

export function SettingsModal({
  open,
  preferences,
  providers,
  onUpdatePreferences,
  onClose,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>('appearance')
  const modalRef = useRef<HTMLDivElement | null>(null)
  useModalDialog(open, modalRef, onClose)

  if (!open) return null

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div ref={modalRef} tabIndex={-1} className="gb-modal">
        <div className="gb-modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <strong>Settings</strong>
            <span className="gb-badge">Phase 1B shell</span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings">
            ×
          </button>
        </div>

        <div className="gb-settings-body">
          <nav className="gb-settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((sec) => (
              <button
                key={sec.id}
                type="button"
                className={activeSection === sec.id ? 'active' : undefined}
                onClick={() => setActiveSection(sec.id)}
              >
                {sec.label}
              </button>
            ))}
          </nav>

          <section className="gb-settings-content">
            {activeSection === 'appearance' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>Appearance</h2>
                <div className="gb-setting-row">
                  <div>
                    <div>Theme</div>
                    <small className="gb-muted">
                      Choose Light, Dark, or match your system preference.
                    </small>
                  </div>
                  <select
                    aria-label="Theme"
                    value={preferences.theme}
                    onChange={(e) =>
                      onUpdatePreferences({ theme: e.target.value as ThemePreference })
                    }
                  >
                    <option value="system">System</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>

                <div className="gb-setting-row">
                  <div>
                    <div>Reduced motion</div>
                    <small className="gb-muted">
                      Disable avatar and UI animations regardless of OS setting.
                    </small>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Reduced motion"
                    checked={preferences.reducedMotion}
                    onChange={(e) => onUpdatePreferences({ reducedMotion: e.target.checked })}
                  />
                </div>

                <div style={{ marginTop: '18px' }}>
                  <h3 style={{ margin: '0 0 10px', fontSize: '14px' }}>
                    Ghost Avatar Presets (12)
                  </h3>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                      gap: '10px',
                    }}
                  >
                    {avatarPresets.map((preset) => (
                      <div
                        key={preset.id}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '8px 4px',
                          border: '1px solid var(--gb-border)',
                          borderRadius: '8px',
                        }}
                      >
                        <BotAvatar
                          config={{
                            shape: preset.id,
                            color: preset.color,
                            eyes: 'classic',
                            rotation: 0,
                            animation: !preferences.reducedMotion,
                          }}
                          status="idle"
                          size={34}
                          label={`${preset.name} preset`}
                        />
                        <small className="gb-muted" style={{ fontSize: '11px' }}>
                          {preset.name}
                        </small>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ marginTop: '18px' }}>
                  <h3 style={{ margin: '0 0 10px', fontSize: '14px' }}>
                    Avatar Status States (7)
                  </h3>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
                    {AVATAR_STATES.map((st) => (
                      <div
                        key={st}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '8px 10px',
                          border: '1px solid var(--gb-border)',
                          borderRadius: '8px',
                        }}
                      >
                        <BotAvatar
                          config={{
                            shape: 'ghost',
                            color: '#418D79',
                            eyes: 'classic',
                            rotation: 0,
                            animation: !preferences.reducedMotion,
                          }}
                          status={st}
                          size={34}
                          label={`${st} state`}
                        />
                        <small className="gb-muted" style={{ fontSize: '11px' }}>
                          {st}
                        </small>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {activeSection === 'accounts' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>Accounts &amp; Providers</h2>
                <p className="gb-muted" style={{ fontSize: '13px', marginTop: 0 }}>
                  Read-only status from daemon IPC. Login/disconnect controls open in Phase 1D.
                </p>
                {providers.length === 0 ? (
                  <p className="gb-muted">No provider status reported.</p>
                ) : (
                  providers.map((p) => (
                    <div key={p.id} className="gb-setting-row">
                      <div>
                        <div>{p.label}</div>
                        <small className="gb-muted">{p.detail}</small>
                      </div>
                      <span className="gb-badge">{p.status}</span>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeSection !== 'appearance' && activeSection !== 'accounts' && (
              <div>
                <h2 style={{ margin: '0 0 10px', fontSize: '17px' }}>
                  {SETTINGS_SECTIONS.find((s) => s.id === activeSection)?.label}
                </h2>
                <p className="gb-muted">
                  This section is scheduled for Phase 1D / later milestones and is intentionally
                  disabled in Phase 1B.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
