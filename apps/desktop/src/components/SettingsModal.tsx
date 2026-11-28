import { useEffect, useRef, useState } from 'react'
import { avatarPresets } from '@ghost-bot/avatar/presets'
import {
  BookOpen,
  Brain,
  CalendarClock,
  ChartNoAxesColumn,
  CircleUserRound,
  Database,
  Layers,
  Monitor,
  Palette,
  Plug,
  Settings,
  Settings2,
  Shield,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  AppSettings,
  AppSettingsPatch,
  DaemonHealthResponse,
  RuntimeProviderCapabilitiesResponse,
  RuntimeProviderId,
  RuntimeSnapshot,
  TeamRecordDto,
} from '@ghost-bot/shared-types/ipc'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { AvatarStatus, ThemePreference, WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { KnowledgeSettingsSection } from './KnowledgeSettingsSection.tsx'
import { McpSettingsSection } from './McpSettingsSection.tsx'
import { LocalSkillsSettingsSection } from './LocalSkillsSettingsSection.tsx'
import { MemorySettingsSection } from './MemorySettingsSection.tsx'
import { RoutinesSettingsSection } from './RoutinesSettingsSection.tsx'
import { ComputerUseSettingsSection } from './ComputerUseSettingsSection.tsx'
import { providerReadinessLabel } from '../state/providerReadiness.ts'

const SETTINGS_SECTIONS: ReadonlyArray<{
  id:
    | 'general'
    | 'appearance'
    | 'accounts'
    | 'models'
    | 'usage'
    | 'personalization'
    | 'memory'
    | 'knowledge'
    | 'tools'
    | 'permissions'
    | 'computer-use'
    | 'routines'
    | 'privacy'
    | 'advanced'
  label: string
  Icon: LucideIcon
}> = [
  { id: 'general', label: 'General', Icon: Settings2 },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'accounts', label: 'Accounts & Providers', Icon: CircleUserRound },
  { id: 'models', label: 'Models', Icon: Layers },
  { id: 'usage', label: 'Usage', Icon: ChartNoAxesColumn },
  { id: 'personalization', label: 'Personalization', Icon: SlidersHorizontal },
  { id: 'memory', label: 'Memory', Icon: Brain },
  { id: 'knowledge', label: 'Knowledge', Icon: BookOpen },
  { id: 'tools', label: 'Tools & MCP', Icon: Plug },
  { id: 'permissions', label: 'Permissions', Icon: Shield },
  { id: 'computer-use', label: 'Computer Use', Icon: Monitor },
  { id: 'routines', label: 'Routines', Icon: CalendarClock },
  { id: 'privacy', label: 'Data & Privacy', Icon: Database },
  { id: 'advanced', label: 'Advanced', Icon: Settings },
]

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
  settings: AppSettings
  runtimeSnapshot: RuntimeSnapshot | null
  providerCapabilities: RuntimeProviderCapabilitiesResponse | null
  daemonHealth: DaemonHealthResponse | null
  bots: WorkspaceBot[]
  teams?: TeamRecordDto[]
  activeBotId?: string | null
  initialSection?: SectionId
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
  onResetSettings: () => Promise<void>
  onRefreshRuntime: () => Promise<void>
  onRefreshProviderCapabilities: (providerId?: RuntimeProviderId) => Promise<void>
  onRefreshWorkspaceRoutines?: () => void
  onNavigateToBot?: (botId: string) => void
  onNavigateToTeam?: (teamId: string) => void
  onOpenComputerUseLiveViewer?: (sessionId?: string) => void
  onClose: () => void
}

export function SettingsModal({
  open,
  settings,
  runtimeSnapshot,
  providerCapabilities,
  daemonHealth,
  bots,
  teams = [],
  activeBotId,
  initialSection,
  onUpdateSettings,
  onResetSettings,
  onRefreshRuntime,
  onRefreshProviderCapabilities,
  onRefreshWorkspaceRoutines,
  onNavigateToBot,
  onNavigateToTeam,
  onOpenComputerUseLiveViewer,
  onClose,
}: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SectionId>(initialSection ?? 'appearance')
  const [refreshing, setRefreshing] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [openClawStatus, setOpenClawStatus] = useState<
    import('@ghost-bot/shared-types/ipc').OpenClawStatusDto | null
  >(null)
  const [ollamaStatus, setOllamaStatus] = useState<
    import('@ghost-bot/shared-types/ipc').OllamaStatusDto | null
  >(null)
  const [claudeStatus, setClaudeStatus] = useState<
    import('@ghost-bot/shared-types/ipc').ClaudeStatusDto | null
  >(null)
  const [claudeApiKeyInput, setClaudeApiKeyInput] = useState('')
  const [claudeBusy, setClaudeBusy] = useState(false)
  const [geminiStatus, setGeminiStatus] = useState<
    import('@ghost-bot/shared-types/ipc').GeminiStatusDto | null
  >(null)
  const [geminiApiKeyInput, setGeminiApiKeyInput] = useState('')
  const [geminiBusy, setGeminiBusy] = useState(false)
  const [kimiStatus, setKimiStatus] = useState<
    import('@ghost-bot/shared-types/ipc').KimiStatusDto | null
  >(null)
  const [lmStudioStatus, setLmStudioStatus] = useState<
    import('@ghost-bot/shared-types/ipc').LocalOpenAiCompatStatusDto | null
  >(null)
  const [lmStudioUrlInput, setLmStudioUrlInput] = useState('http://127.0.0.1:1234/v1')
  const [llamaCppStatus, setLlamaCppStatus] = useState<
    import('@ghost-bot/shared-types/ipc').LocalOpenAiCompatStatusDto | null
  >(null)
  const [llamaCppUrlInput, setLlamaCppUrlInput] = useState('http://127.0.0.1:8080/v1')
  const [openRouterStatus, setOpenRouterStatus] = useState<
    import('@ghost-bot/shared-types/ipc').OpenRouterStatusDto | null
  >(null)
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState('')
  const [openRouterBusy, setOpenRouterBusy] = useState(false)
  const [capabilityRefreshId, setCapabilityRefreshId] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    if (initialSection) setActiveSection(initialSection)
    setConfirmReset(false)
    setErrorMsg(null)
    setClaudeApiKeyInput('')
    setGeminiApiKeyInput('')
    if (window.ghostBot?.getOpenClawStatus) {
      void window.ghostBot
        .getOpenClawStatus()
        .then(setOpenClawStatus)
        .catch((err: unknown) => {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to load OpenClaw status')
          setOpenClawStatus(null)
        })
    }
    if (window.ghostBot?.getOllamaStatus) {
      void window.ghostBot
        .getOllamaStatus()
        .then(setOllamaStatus)
        .catch(() => {
          setOllamaStatus(null)
        })
    }
    if (window.ghostBot?.getClaudeStatus) {
      void window.ghostBot
        .getClaudeStatus()
        .then(setClaudeStatus)
        .catch(() => {
          setClaudeStatus(null)
        })
    }
    if (window.ghostBot?.getGeminiStatus) {
      void window.ghostBot
        .getGeminiStatus()
        .then(setGeminiStatus)
        .catch(() => {
          setGeminiStatus(null)
        })
    }
    if (window.ghostBot?.getKimiStatus) {
      void window.ghostBot
        .getKimiStatus()
        .then(setKimiStatus)
        .catch(() => {
          setKimiStatus(null)
        })
    }
    if (window.ghostBot?.getLmStudioStatus) {
      void window.ghostBot
        .getLmStudioStatus()
        .then((s) => {
          setLmStudioStatus(s)
          setLmStudioUrlInput(s.baseUrl)
        })
        .catch(() => setLmStudioStatus(null))
    }
    if (window.ghostBot?.getLlamaCppStatus) {
      void window.ghostBot
        .getLlamaCppStatus()
        .then((s) => {
          setLlamaCppStatus(s)
          setLlamaCppUrlInput(s.baseUrl)
        })
        .catch(() => setLlamaCppStatus(null))
    }
    if (window.ghostBot?.getOpenRouterStatus) {
      void window.ghostBot
        .getOpenRouterStatus()
        .then(setOpenRouterStatus)
        .catch(() => setOpenRouterStatus(null))
    }
  }, [open, initialSection])

  useModalDialog(open, modalRef, onClose)

  if (!open) return null

  const runUpdate = (patch: AppSettingsPatch) => {
    setErrorMsg(null)
    void onUpdateSettings(patch).catch((err: unknown) => {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save setting')
    })
  }

  const handleRefresh = () => {
    if (refreshing) return
    setRefreshing(true)
    setErrorMsg(null)
    void onRefreshRuntime()
      .catch((err: unknown) => {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to refresh runtime')
      })
      .finally(() => setRefreshing(false))
  }

  const refreshProviderCapabilities = async (providerId?: RuntimeProviderId) => {
    setCapabilityRefreshId(providerId ?? 'all')
    setErrorMsg(null)
    try {
      await onRefreshProviderCapabilities(providerId)
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : 'Provider status could not be refreshed.')
    } finally {
      setCapabilityRefreshId(null)
    }
  }

  const isMock = !runtimeSnapshot || runtimeSnapshot.runtimeMode === 'mock'

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div ref={modalRef} tabIndex={-1} className="gb-modal">
        <div className="gb-modal-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <strong>Settings</strong>
            <span className="gb-badge">{isMock ? 'Mock mode' : 'Codex bridge'}</span>
          </div>
          <IconButton label="Close settings" onClick={onClose}>
            <X size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="gb-settings-body">
          <nav className="gb-settings-nav" aria-label="Settings sections">
            {SETTINGS_SECTIONS.map((sec) => {
              const SectionIcon = sec.Icon
              return (
                <button
                  key={sec.id}
                  type="button"
                  className={activeSection === sec.id ? 'active' : undefined}
                  onClick={() => setActiveSection(sec.id)}
                >
                  <SectionIcon
                    size={ICON_SIZE.sm}
                    strokeWidth={ICON_STROKE}
                    aria-hidden="true"
                    style={{ flexShrink: 0 }}
                  />
                  <span>{sec.label}</span>
                </button>
              )
            })}
          </nav>

          <section className="gb-settings-content">
            {errorMsg && (
              <div
                role="alert"
                style={{
                  marginBottom: '12px',
                  padding: '8px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--gb-danger)',
                  color: 'var(--gb-danger)',
                  fontSize: '13px',
                }}
              >
                {errorMsg}
              </div>
            )}

            {activeSection === 'general' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  General <span className="gb-badge">Persisted</span>
                </h2>
                <div className="gb-setting-row">
                  <div>
                    <div>On launch</div>
                    <small className="gb-muted">
                      Choose whether to restore the last active bot or start fresh.
                    </small>
                  </div>
                  <select
                    aria-label="Launch behavior"
                    value={settings.general.launchBehavior}
                    onChange={(e) =>
                      runUpdate({
                        general: {
                          launchBehavior: e.target.value as 'restore' | 'new-session',
                        },
                      })
                    }
                  >
                    <option value="restore">Restore last bot</option>
                    <option value="new-session">Start fresh</option>
                  </select>
                </div>
                <div className="gb-setting-row">
                  <div>
                    <div>Local diagnostics opt-in</div>
                    <small className="gb-muted">
                      Store redacted diagnostic metadata locally (never sends telemetry).
                    </small>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Local diagnostics opt-in"
                    checked={settings.general.diagnosticsOptIn}
                    onChange={(e) =>
                      runUpdate({ general: { diagnosticsOptIn: e.target.checked } })
                    }
                  />
                </div>
              </div>
            )}

            {activeSection === 'appearance' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Appearance <span className="gb-badge">Persisted</span>
                </h2>
                <div className="gb-setting-row">
                  <div>
                    <div>Theme</div>
                    <small className="gb-muted">
                      Choose Light, Dark, or match your system preference.
                    </small>
                  </div>
                  <select
                    aria-label="Theme"
                    value={settings.appearance.theme}
                    onChange={(e) =>
                      runUpdate({
                        appearance: { theme: e.target.value as ThemePreference },
                      })
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
                    checked={settings.appearance.reducedMotion}
                    onChange={(e) =>
                      runUpdate({ appearance: { reducedMotion: e.target.checked } })
                    }
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
                            animation: !settings.appearance.reducedMotion,
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
                            animation: !settings.appearance.reducedMotion,
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
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: '17px' }}>
                    Accounts &amp; Providers <span className="gb-badge">Runtime-managed</span>
                  </h2>
                  <button
                    type="button"
                    className="gb-btn-outline"
                    disabled={refreshing}
                    onClick={handleRefresh}
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh status'}
                  </button>
                </div>

                {runtimeSnapshot && (
                  <div
                    className="gb-card"
                    style={{ marginBottom: '14px', display: 'grid', gap: '6px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <strong>
                        {runtimeSnapshot.runtimeMode === 'mock'
                          ? 'Mock Offline Runtime'
                          : `Codex App Server ${runtimeSnapshot.codexVersion ?? '(not detected)'}`}
                      </strong>
                      <span className="gb-badge">{runtimeSnapshot.status}</span>
                    </div>
                    <small className="gb-muted">{runtimeSnapshot.detail}</small>
                    <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>Auth: {runtimeSnapshot.authMethod}</span>
                      <span>Plan: {runtimeSnapshot.planType ?? 'Unavailable'}</span>
                      <span>Workspace: {runtimeSnapshot.workspaceName ?? 'Unavailable'}</span>
                    </div>
                    <small className="gb-muted" style={{ fontSize: '11px' }}>
                      Observed: {runtimeSnapshot.observedAt}
                      {runtimeSnapshot.cached ? ' (cached)' : ''}
                    </small>
                    {runtimeSnapshot.status === 'auth-required' && (
                      <code
                        style={{
                          fontSize: '11.5px',
                          padding: '6px 8px',
                          background: 'var(--gb-surface)',
                          borderRadius: '6px',
                        }}
                      >
                        CODEX_HOME=~/.config/ghost-bot/codex-profile codex login --device-auth
                      </code>
                    )}
                  </div>
                )}

                <div aria-label="Provider capability status" style={{ display: 'grid', gap: '6px', marginBottom: '14px' }}>
                  {providerCapabilities?.selectedBot && (
                    <div className="gb-card" data-testid="selected-bot-readiness" role="status" style={{ display: 'grid', gap: '4px' }}>
                      <strong>
                        {bots.find((bot) => bot.id === providerCapabilities.selectedBot?.botId)?.name ?? 'Selected bot'} · {providerReadinessLabel(providerCapabilities.selectedBot)}
                      </strong>
                      <small className="gb-muted">{providerCapabilities.selectedBot.reason}</small>
                    </div>
                  )}
                  {!providerCapabilities ? (
                    <p className="gb-muted" role="status">Provider capability status is being checked by the daemon.</p>
                  ) : providerCapabilities.providers.map((provider) => (
                    <div key={provider.id} className="gb-setting-row" data-provider-id={provider.id}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                          <strong>{provider.label}</strong>
                          <span className="gb-badge">{provider.authentication}</span>
                          <span className="gb-badge">{provider.catalogState}</span>
                        </div>
                        <small className="gb-muted">
                          Installed {provider.installed === null ? 'unknown' : provider.installed ? 'yes' : 'no'} ·
                          {' '}Configured {provider.configured ? 'yes' : 'no'} ·
                          {' '}{provider.models.length} discovered model{provider.models.length === 1 ? '' : 's'}
                          {provider.catalogObservedAt ? ` · observed ${provider.catalogObservedAt}` : ''}
                        </small>
                        <small className="gb-muted" style={{ display: 'block' }}>
                          {provider.executionReady ? 'Execution authorized by provider policy; bot and workspace checks still apply.' : provider.executionReason}
                        </small>
                        {provider.diagnostics.length > 0 && (
                          <details style={{ marginTop: '4px', fontSize: '11px' }}>
                            <summary>Diagnostics</summary>
                            <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
                              {provider.diagnostics.map((diagnostic, index) => <li key={`${provider.id}-${index}`}>{diagnostic}</li>)}
                            </ul>
                          </details>
                        )}
                      </div>
                      {provider.id !== 'mock-offline' && (
                        <button
                          type="button"
                          className="gb-btn-outline"
                          disabled={capabilityRefreshId !== null}
                          onClick={() => void refreshProviderCapabilities(
                            provider.kind === 'api' ? provider.id : undefined,
                          )}
                        >
                          {capabilityRefreshId === provider.id || capabilityRefreshId === 'all'
                            ? 'Checking…'
                            : provider.kind === 'api' ? 'Discover models' : 'Refresh models'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {openClawStatus && (
                  <div
                    className="gb-card"
                    data-testid="openclaw-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '6px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        OpenClaw Gateway {openClawStatus.runtimeVersion ?? '(not detected)'}
                      </strong>
                      <span className="gb-badge" data-testid="openclaw-auth-badge">
                        {openClawStatus.available ? openClawStatus.authStatus : 'unavailable'}
                      </span>
                    </div>
                    <small className="gb-muted">{openClawStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>URL: {openClawStatus.gatewayUrl}</span>
                      <span>Version verified: {openClawStatus.supportedVersion ? 'yes' : 'no'}</span>
                      <span>Host desktop: {openClawStatus.hostDesktopEnabled ? 'enabled' : 'disabled'}</span>
                      <span>Models: {openClawStatus.models.length}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">
                        streaming: {openClawStatus.capabilities.streaming ? 'on' : 'off'}
                      </span>
                      <span className="gb-badge">
                        sandbox: {openClawStatus.capabilities.sandbox ? 'verified' : 'unverified'}
                      </span>
                      <span className="gb-badge">
                        usage: {openClawStatus.capabilities.usage ? 'reported' : 'unavailable'}
                      </span>
                    </div>
                    {openClawStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="openclaw-gated-reason">
                        Execution gate: {openClawStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {ollamaStatus && (
                  <div
                    className="gb-card"
                    data-testid="ollama-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '6px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        Ollama Local {ollamaStatus.runtimeVersion ?? '(not detected)'}
                      </strong>
                      <span className="gb-badge" data-testid="ollama-auth-badge">
                        {ollamaStatus.available ? ollamaStatus.authStatus : 'unavailable'}
                      </span>
                    </div>
                    <small className="gb-muted">{ollamaStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>URL: {ollamaStatus.baseUrl}</span>
                      <span>Local-only verified: {ollamaStatus.localOnlyVerified ? 'yes' : 'no'}</span>
                      <span>Installed models: {ollamaStatus.models.length}</span>
                      <span>Running: {ollamaStatus.runningModels.length}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">
                        max concurrent: {ollamaStatus.resourceLimits.maxConcurrentRuns}
                      </span>
                      <span className="gb-badge">
                        max output: {ollamaStatus.resourceLimits.maxOutputTokens} tok
                      </span>
                      <span className="gb-badge">
                        history: {ollamaStatus.resourceLimits.maxHistoryMessages} turns /{' '}
                        {Math.round(ollamaStatus.resourceLimits.maxHistoryBytes / 1024)} KB
                      </span>
                    </div>
                    {ollamaStatus.diagnostics.map((d, idx) => (
                      <small key={idx} className="gb-muted">
                        Diagnostic: {d}
                      </small>
                    ))}
                    {ollamaStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="ollama-gated-reason">
                        Execution gate: {ollamaStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {claudeStatus && (
                  <div
                    className="gb-card"
                    data-testid="claude-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '8px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>Anthropic Claude API (API-key billed)</strong>
                      <span className="gb-badge" data-testid="claude-auth-badge">
                        {claudeStatus.authStatus}
                      </span>
                    </div>
                    <small className="gb-muted">{claudeStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>Endpoint: {claudeStatus.endpoint}</span>
                      <span>Keyring: {claudeStatus.keyringAvailable ? 'available' : claudeStatus.keyringLocked ? 'locked' : 'unavailable'}</span>
                      <span>Key: {claudeStatus.maskedKeyHint ?? 'not configured'}</span>
                      <span>Gen: {claudeStatus.credentialGeneration}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">billing: API-key billed (not Pro/Max)</span>
                      <span className="gb-badge">tools: disabled (read-only chat)</span>
                      <span className="gb-badge">claude code cli: disabled</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        data-testid="claude-api-key-input"
                        value={claudeApiKeyInput}
                        onChange={(e) => setClaudeApiKeyInput(e.target.value)}
                        placeholder={
                          claudeStatus.credentialConfigured
                            ? 'Replace Anthropic API key (sk-ant-...)'
                            : 'Enter Anthropic API key (sk-ant-...)'
                        }
                        autoComplete="off"
                        style={{ flex: '1 1 220px' }}
                      />
                      <button
                        type="button"
                        data-testid="claude-save-key-btn"
                        disabled={claudeBusy || claudeApiKeyInput.trim().length < 8}
                        onClick={() => {
                          if (!window.ghostBot?.setClaudeCredential) return
                          setClaudeBusy(true)
                          setErrorMsg(null)
                          void window.ghostBot
                            .setClaudeCredential({ apiKey: claudeApiKeyInput.trim(), accountRef: 'default' })
                            .then((next) => {
                              setClaudeStatus(next)
                              setClaudeApiKeyInput('')
                              void refreshProviderCapabilities()
                            })
                            .catch((err: unknown) => {
                              setErrorMsg(err instanceof Error ? err.message : 'Failed to save API key')
                            })
                            .finally(() => setClaudeBusy(false))
                        }}
                      >
                        {claudeStatus.credentialConfigured ? 'Replace key' : 'Save key'}
                      </button>
                      {claudeStatus.credentialConfigured && (
                        <>
                          <button
                            type="button"
                            data-testid="claude-delete-key-btn"
                            disabled={claudeBusy}
                            onClick={() => {
                              if (!window.ghostBot?.deleteClaudeCredential) return
                              setClaudeBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .deleteClaudeCredential()
                                .then((next) => { setClaudeStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) => {
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to delete API key')
                                })
                                .finally(() => setClaudeBusy(false))
                            }}
                          >
                            Delete key
                          </button>
                          <button
                            type="button"
                            data-testid="claude-toggle-auth-btn"
                            disabled={claudeBusy}
                            onClick={() => {
                              if (!window.ghostBot?.setClaudeExecutionAuthorized) return
                              setClaudeBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .setClaudeExecutionAuthorized({
                                  authorized: !claudeStatus.executionAuthorized,
                                })
                                .then((next) => { setClaudeStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) => {
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to update authorization')
                                })
                                .finally(() => setClaudeBusy(false))
                            }}
                          >
                            {claudeStatus.executionAuthorized ? 'Revoke API opt-in' : 'Authorize API-billed chat'}
                          </button>
                        </>
                      )}
                    </div>
                    {claudeStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="claude-gated-reason">
                        Execution gate: {claudeStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {geminiStatus && (
                  <div
                    className="gb-card"
                    data-testid="gemini-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '8px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>Google Gemini API (API key)</strong>
                      <span className="gb-badge" data-testid="gemini-auth-badge">
                        {geminiStatus.authStatus}
                      </span>
                    </div>
                    <small className="gb-muted">{geminiStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>Endpoint: {geminiStatus.endpoint}</span>
                      <span>
                        Keyring:{' '}
                        {geminiStatus.keyringAvailable
                          ? 'available'
                          : geminiStatus.keyringLocked
                            ? 'locked'
                            : 'unavailable'}
                      </span>
                      <span>Key: {geminiStatus.maskedKeyHint ?? 'not configured'}</span>
                      <span>Gen: {geminiStatus.credentialGeneration}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">billing: API key (free-tier eligibility varies; not Google AI sub)</span>
                      <span className="gb-badge">tools: disabled (read-only chat)</span>
                      <span className="gb-badge">gemini cli: disabled</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        data-testid="gemini-api-key-input"
                        value={geminiApiKeyInput}
                        onChange={(e) => setGeminiApiKeyInput(e.target.value)}
                        placeholder={
                          geminiStatus.credentialConfigured
                            ? 'Replace Gemini API key (AIza...)'
                            : 'Enter Gemini API key (AIza...)'
                        }
                        autoComplete="off"
                        style={{ flex: '1 1 220px' }}
                      />
                      <button
                        type="button"
                        data-testid="gemini-save-key-btn"
                        disabled={geminiBusy || geminiApiKeyInput.trim().length < 8}
                        onClick={() => {
                          if (!window.ghostBot?.setGeminiCredential) return
                          setGeminiBusy(true)
                          setErrorMsg(null)
                          void window.ghostBot
                            .setGeminiCredential({ apiKey: geminiApiKeyInput.trim(), accountRef: 'default' })
                            .then((next) => {
                              setGeminiStatus(next)
                              setGeminiApiKeyInput('')
                              void refreshProviderCapabilities()
                            })
                            .catch((err: unknown) => {
                              setErrorMsg(err instanceof Error ? err.message : 'Failed to save Gemini API key')
                            })
                            .finally(() => setGeminiBusy(false))
                        }}
                      >
                        {geminiStatus.credentialConfigured ? 'Replace key' : 'Save key'}
                      </button>
                      {geminiStatus.credentialConfigured && (
                        <>
                          <button
                            type="button"
                            data-testid="gemini-delete-key-btn"
                            disabled={geminiBusy}
                            onClick={() => {
                              if (!window.ghostBot?.deleteGeminiCredential) return
                              setGeminiBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .deleteGeminiCredential()
                                .then((next) => { setGeminiStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) => {
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to delete Gemini API key')
                                })
                                .finally(() => setGeminiBusy(false))
                            }}
                          >
                            Delete key
                          </button>
                          <button
                            type="button"
                            data-testid="gemini-toggle-auth-btn"
                            disabled={geminiBusy}
                            onClick={() => {
                              if (!window.ghostBot?.setGeminiExecutionAuthorized) return
                              setGeminiBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .setGeminiExecutionAuthorized({
                                  authorized: !geminiStatus.executionAuthorized,
                                })
                                .then((next) => { setGeminiStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) => {
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to update authorization')
                                })
                                .finally(() => setGeminiBusy(false))
                            }}
                          >
                            {geminiStatus.executionAuthorized ? 'Revoke API opt-in' : 'Authorize Gemini API'}
                          </button>
                        </>
                      )}
                    </div>
                    {geminiStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="gemini-gated-reason">
                        Execution gate: {geminiStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {kimiStatus && (
                  <div
                    className="gb-card"
                    data-testid="kimi-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '6px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>
                        Kimi Code ACP {kimiStatus.cliVersion ?? '(not installed)'}
                      </strong>
                      <span className="gb-badge" data-testid="kimi-auth-badge">
                        {kimiStatus.cliAvailable ? kimiStatus.authStatus : 'unavailable'}
                      </span>
                    </div>
                    <small className="gb-muted">{kimiStatus.detail}</small>
                    <small className="gb-muted">{kimiStatus.loginGuidance}</small>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">
                        ACP v{kimiStatus.protocolVersion ?? '?'}:{' '}
                        {kimiStatus.acpProtocolSupported ? 'verified' : 'unverified'}
                      </span>
                      <span className="gb-badge">client fs/terminal: disabled</span>
                      <span className="gb-badge">allow_always: rejected</span>
                    </div>
                    {kimiStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="kimi-gated-reason">
                        Execution gate: {kimiStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {lmStudioStatus && (
                  <div
                    className="gb-card"
                    data-testid="lmstudio-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '8px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>LM Studio (Local OpenAI-compatible)</strong>
                      <span className="gb-badge" data-testid="lmstudio-auth-badge">
                        {lmStudioStatus.available ? 'connected' : 'unavailable'}
                      </span>
                    </div>
                    <small className="gb-muted">{lmStudioStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        data-testid="lmstudio-url-input"
                        value={lmStudioUrlInput}
                        onChange={(e) => setLmStudioUrlInput(e.target.value)}
                        style={{ flex: '1 1 220px' }}
                      />
                      <button
                        type="button"
                        data-testid="lmstudio-save-url-btn"
                        onClick={() => {
                          if (!window.ghostBot?.setLmStudioConfig) return
                          setErrorMsg(null)
                          void window.ghostBot
                            .setLmStudioConfig({ baseUrl: lmStudioUrlInput.trim() })
                            .then((next) => { setLmStudioStatus(next); void refreshProviderCapabilities() })
                            .catch((err: unknown) =>
                              setErrorMsg(err instanceof Error ? err.message : 'Invalid LM Studio URL'),
                            )
                        }}
                      >
                        Save endpoint
                      </button>
                    </div>
                    {lmStudioStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="lmstudio-gated-reason">
                        Execution gate: {lmStudioStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {llamaCppStatus && (
                  <div
                    className="gb-card"
                    data-testid="llamacpp-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '8px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>llama.cpp Server (Local OpenAI-compatible)</strong>
                      <span className="gb-badge" data-testid="llamacpp-auth-badge">
                        {llamaCppStatus.available ? 'connected' : 'unavailable'}
                      </span>
                    </div>
                    <small className="gb-muted">{llamaCppStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        data-testid="llamacpp-url-input"
                        value={llamaCppUrlInput}
                        onChange={(e) => setLlamaCppUrlInput(e.target.value)}
                        style={{ flex: '1 1 220px' }}
                      />
                      <button
                        type="button"
                        data-testid="llamacpp-save-url-btn"
                        onClick={() => {
                          if (!window.ghostBot?.setLlamaCppConfig) return
                          setErrorMsg(null)
                          void window.ghostBot
                            .setLlamaCppConfig({ baseUrl: llamaCppUrlInput.trim() })
                            .then((next) => { setLlamaCppStatus(next); void refreshProviderCapabilities() })
                            .catch((err: unknown) =>
                              setErrorMsg(err instanceof Error ? err.message : 'Invalid llama.cpp URL'),
                            )
                        }}
                      >
                        Save endpoint
                      </button>
                    </div>
                    {llamaCppStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="llamacpp-gated-reason">
                        Execution gate: {llamaCppStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}

                {openRouterStatus && (
                  <div
                    className="gb-card"
                    data-testid="openrouter-status-card"
                    style={{ marginTop: '14px', display: 'grid', gap: '8px' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <strong>OpenRouter API (API-key billed)</strong>
                      <span className="gb-badge" data-testid="openrouter-auth-badge">
                        {openRouterStatus.authStatus}
                      </span>
                    </div>
                    <small className="gb-muted">{openRouterStatus.detail}</small>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', fontSize: '12px' }}>
                      <span>Endpoint: {openRouterStatus.endpoint}</span>
                      <span>Key: {openRouterStatus.maskedKeyHint ?? 'not configured'}</span>
                      <span>Gen: {openRouterStatus.credentialGeneration}</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11.5px' }}>
                      <span className="gb-badge">billing: API-key billed (not ChatGPT/Claude/Gemini sub)</span>
                      <span className="gb-badge">allow_fallbacks: false</span>
                      <span className="gb-badge">tools: disabled (read-only chat)</span>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        type="password"
                        data-testid="openrouter-api-key-input"
                        value={openRouterApiKeyInput}
                        onChange={(e) => setOpenRouterApiKeyInput(e.target.value)}
                        placeholder={
                          openRouterStatus.credentialConfigured
                            ? 'Replace OpenRouter API key (sk-or-v1-...)'
                            : 'Enter OpenRouter API key (sk-or-v1-...)'
                        }
                        autoComplete="off"
                        style={{ flex: '1 1 220px' }}
                      />
                      <button
                        type="button"
                        data-testid="openrouter-save-key-btn"
                        disabled={openRouterBusy || openRouterApiKeyInput.trim().length < 8}
                        onClick={() => {
                          if (!window.ghostBot?.setOpenRouterCredential) return
                          setOpenRouterBusy(true)
                          setErrorMsg(null)
                          void window.ghostBot
                            .setOpenRouterCredential({
                              apiKey: openRouterApiKeyInput.trim(),
                              accountRef: 'default',
                            })
                            .then((next) => {
                              setOpenRouterStatus(next)
                              setOpenRouterApiKeyInput('')
                              void refreshProviderCapabilities()
                            })
                            .catch((err: unknown) =>
                              setErrorMsg(err instanceof Error ? err.message : 'Failed to save OpenRouter key'),
                            )
                            .finally(() => setOpenRouterBusy(false))
                        }}
                      >
                        {openRouterStatus.credentialConfigured ? 'Replace key' : 'Save key'}
                      </button>
                      {openRouterStatus.credentialConfigured && (
                        <>
                          <button
                            type="button"
                            data-testid="openrouter-delete-key-btn"
                            disabled={openRouterBusy}
                            onClick={() => {
                              if (!window.ghostBot?.deleteOpenRouterCredential) return
                              setOpenRouterBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .deleteOpenRouterCredential()
                                .then((next) => { setOpenRouterStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) =>
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to delete key'),
                                )
                                .finally(() => setOpenRouterBusy(false))
                            }}
                          >
                            Delete key
                          </button>
                          <button
                            type="button"
                            data-testid="openrouter-toggle-auth-btn"
                            disabled={openRouterBusy}
                            onClick={() => {
                              if (!window.ghostBot?.setOpenRouterExecutionAuthorized) return
                              setOpenRouterBusy(true)
                              setErrorMsg(null)
                              void window.ghostBot
                                .setOpenRouterExecutionAuthorized({
                                  authorized: !openRouterStatus.executionAuthorized,
                                })
                                .then((next) => { setOpenRouterStatus(next); void refreshProviderCapabilities() })
                                .catch((err: unknown) =>
                                  setErrorMsg(err instanceof Error ? err.message : 'Failed to update authorization'),
                                )
                                .finally(() => setOpenRouterBusy(false))
                            }}
                          >
                            {openRouterStatus.executionAuthorized
                              ? 'Revoke OpenRouter opt-in'
                              : 'Authorize OpenRouter API'}
                          </button>
                        </>
                      )}
                    </div>
                    {openRouterStatus.policyCompatibility.gatedReason && (
                      <small className="gb-muted" data-testid="openrouter-gated-reason">
                        Execution gate: {openRouterStatus.policyCompatibility.gatedReason}
                      </small>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeSection === 'models' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Models <span className="gb-badge">Runtime-managed</span>
                </h2>
                <p className="gb-muted" style={{ fontSize: '13px', marginTop: 0 }}>
                  Discovered model catalog without initiating inference.
                </p>
                {!runtimeSnapshot || runtimeSnapshot.models.length === 0 ? (
                  <p className="gb-muted">No models discovered for current runtime state.</p>
                ) : (
                  runtimeSnapshot.models.map((m) => (
                    <div key={m.id} className="gb-setting-row">
                      <div>
                        <div>{m.label}</div>
                        <small className="gb-muted">ID: {m.id}</small>
                      </div>
                      <small className="gb-muted">
                        Efforts: {m.efforts.join(', ') || 'none'}
                      </small>
                    </div>
                  ))
                )}

                {openClawStatus && openClawStatus.models.length > 0 && (
                  <div style={{ marginTop: '14px' }}>
                    <h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>
                      OpenClaw Gateway Models ({openClawStatus.models.length})
                    </h3>
                    {openClawStatus.models.slice(0, 20).map((m) => (
                      <div key={m.id} className="gb-setting-row">
                        <div>
                          <div>{m.label}</div>
                          <small className="gb-muted">ID: {m.id}</small>
                        </div>
                        <small className="gb-muted">
                          Efforts: {m.efforts.join(', ') || 'none'}
                        </small>
                      </div>
                    ))}
                  </div>
                )}

                {ollamaStatus && (
                  <div style={{ marginTop: '14px' }} data-testid="ollama-models-section">
                    <h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>
                      Ollama Local Models ({ollamaStatus.models.length})
                    </h3>
                    {ollamaStatus.models.length === 0 ? (
                      <p className="gb-muted" style={{ fontSize: '12.5px', margin: 0 }}>
                        {ollamaStatus.available
                          ? 'No local Ollama models installed.'
                          : 'Ollama daemon not detected on loopback http://127.0.0.1:11434.'}
                      </p>
                    ) : (
                      ollamaStatus.models.slice(0, 20).map((m) => {
                        const running = ollamaStatus.runningModels.some((r) => r.name === m.id)
                        const sizeMb =
                          m.sizeBytes !== null ? `${Math.round(m.sizeBytes / (1024 * 1024))} MB` : 'unknown size'
                        return (
                          <div key={m.id} className="gb-setting-row">
                            <div>
                              <div>
                                {m.label} {running ? <span className="gb-badge">running</span> : null}
                              </div>
                              <small className="gb-muted">
                                {m.parameterSize ?? 'unknown params'} · {m.quantizationLevel ?? 'unknown quant'} · {sizeMb}
                              </small>
                            </div>
                            <small className="gb-muted">
                              ctx: {m.contextLength ?? 'unknown'}
                            </small>
                          </div>
                        )
                      })
                    )}
                  </div>
                )}

                {runtimeSnapshot &&
                  runtimeSnapshot.runtimeMode === 'codex' &&
                  runtimeSnapshot.models.length > 0 &&
                  bots.some((b) => !runtimeSnapshot.models.some((m) => m.id === b.modelId)) && (
                    <div
                      role="alert"
                      style={{
                        marginTop: '12px',
                        padding: '8px 12px',
                        borderRadius: '8px',
                        border: '1px solid var(--gb-border)',
                        fontSize: '12.5px',
                      }}
                    >
                      Some saved bots reference models not in the discovered Codex catalog; their
                      configured IDs are preserved without silent substitution.
                    </div>
                  )}
              </div>
            )}

            {activeSection === 'usage' && (
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '12px',
                  }}
                >
                  <h2 style={{ margin: 0, fontSize: '17px' }}>
                    Usage{' '}
                    <span className="gb-badge">
                      {runtimeSnapshot?.status === 'stale'
                        ? 'stale'
                        : (runtimeSnapshot?.usageStatus ?? 'unavailable')}
                    </span>
                  </h2>
                  <button
                    type="button"
                    className="gb-btn-outline"
                    disabled={refreshing}
                    onClick={handleRefresh}
                  >
                    {refreshing ? 'Refreshing...' : 'Refresh usage'}
                  </button>
                </div>

                {!runtimeSnapshot || runtimeSnapshot.runtimeMode === 'mock' ? (
                  <div className="gb-card">
                    <div>Mock mode active (local sample)</div>
                    <small className="gb-muted">
                      Real subscription usage is unavailable in mock mode. Sample workspace bars are
                      demonstration data only.
                    </small>
                  </div>
                ) : runtimeSnapshot.usageWindows.length === 0 ? (
                  <div className="gb-card">
                    <div>No rate-limit windows reported</div>
                    <small className="gb-muted">
                      Source: {runtimeSnapshot.runtimeMode} ({runtimeSnapshot.authMethod}) ·{' '}
                      {runtimeSnapshot.detail}
                    </small>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: '12px' }}>
                    <div className="gb-card">
                      <div>
                        Source: Provider subscription ({runtimeSnapshot.runtimeMode} ·{' '}
                        {runtimeSnapshot.authMethod}
                        {runtimeSnapshot.planType ? ` / ${runtimeSnapshot.planType}` : ''})
                      </div>
                      <small className="gb-muted">
                        Last refreshed:{' '}
                        {runtimeSnapshot.usageObservedAt ?? runtimeSnapshot.observedAt}
                      </small>
                    </div>
                    {runtimeSnapshot.usageWindows.map((w) => (
                      <div key={w.label} className="gb-card">
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <strong>Window ({w.label})</strong>
                          <span>
                            {w.usedPercent !== null
                              ? `${w.usedPercent}% used · ${Math.max(0, 100 - w.usedPercent)}% remaining`
                              : 'Unavailable'}
                          </span>
                        </div>
                        <div className="gb-bar" aria-hidden="true">
                          <div
                            className="gb-bar-fill"
                            style={{ width: `${w.usedPercent ?? 0}%` }}
                          />
                        </div>
                        <small className="gb-muted">
                          Resets: {w.resetAt ?? 'Unavailable'}
                        </small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeSection === 'personalization' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Personalization <span className="gb-badge">Persisted · Phase 2+</span>
                </h2>
                <p className="gb-muted" style={{ fontSize: '12.5px', marginTop: 0 }}>
                  Saved locally for Phase 2+ runs; does not initiate or alter model inference in
                  Phase 1D.
                </p>
                <div className="gb-setting-row">
                  <div>
                    <div>Response style</div>
                    <small className="gb-muted">Default tone preference for new bots.</small>
                  </div>
                  <select
                    aria-label="Response style"
                    value={settings.personalization.responseStyle}
                    onChange={(e) =>
                      runUpdate({
                        personalization: {
                          responseStyle: e.target.value as 'concise' | 'balanced' | 'detailed',
                        },
                      })
                    }
                  >
                    <option value="concise">Concise</option>
                    <option value="balanced">Balanced</option>
                    <option value="detailed">Detailed</option>
                  </select>
                </div>
                <div style={{ marginTop: '12px', display: 'grid', gap: '6px' }}>
                  <label htmlFor="gb-default-instructions">Default system instructions</label>
                  <textarea
                    id="gb-default-instructions"
                    rows={3}
                    maxLength={2000}
                    value={settings.personalization.defaultInstructions}
                    onChange={(e) =>
                      runUpdate({
                        personalization: { defaultInstructions: e.target.value },
                      })
                    }
                    placeholder="Optional default instructions applied to new bots"
                  />
                </div>
              </div>
            )}

            {activeSection === 'permissions' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Permissions <span className="gb-badge">Policy-enforced</span>
                </h2>
                <div className="gb-setting-row">
                  <div>
                    <div>Default permission mode</div>
                    <small className="gb-muted">
                      Full Access remains disabled until explicit Phase 2 boundary verification.
                    </small>
                  </div>
                  <select
                    aria-label="Default permission mode"
                    value={settings.permissions.defaultPermissionMode}
                    onChange={(e) =>
                      runUpdate({
                        permissions: {
                          defaultPermissionMode: e.target.value as
                            | 'read-only'
                            | 'ask-approval'
                            | 'workspace',
                        },
                      })
                    }
                  >
                    <option value="read-only">Read Only</option>
                    <option value="ask-approval">Ask approval</option>
                    <option value="workspace">Workspace Access</option>
                    <option value="full-access" disabled>
                      Full Access (Disabled)
                    </option>
                  </select>
                </div>
                <div className="gb-setting-row">
                  <div>
                    <div>Verified runtime modes</div>
                    <small className="gb-muted">
                      Enforced by daemon policy broker (version-bound).
                    </small>
                  </div>
                  <span className="gb-badge">
                    {runtimeSnapshot?.verifiedPermissionModes.join(', ') || 'none (mock)'}
                  </span>
                </div>
              </div>
            )}

            {activeSection === 'privacy' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Data &amp; Privacy <span className="gb-badge">Persisted</span>
                </h2>
                <div className="gb-setting-row">
                  <div>
                    <div>Credential &amp; token redaction</div>
                    <small className="gb-muted">
                      Tokens, API keys, and Authorization headers are always redacted across IPC,
                      logs, and errors.
                    </small>
                  </div>
                  <span className="gb-badge">Always enforced</span>
                </div>
                <div className="gb-setting-row">
                  <div>
                    <div>Redact extra diagnostic details in local logs</div>
                    <small className="gb-muted">
                      Optional extra masking for non-secret diagnostic metadata. Mandatory secret
                      redaction cannot be disabled.
                    </small>
                  </div>
                  <input
                    type="checkbox"
                    aria-label="Redact extra diagnostic details in local logs"
                    checked={settings.privacy.redactLogs}
                    onChange={(e) =>
                      runUpdate({ privacy: { redactLogs: e.target.checked } })
                    }
                  />
                </div>
                <div className="gb-setting-row">
                  <div>
                    <div>Local audit retention (days)</div>
                    <small className="gb-muted">1 to 365 days.</small>
                  </div>
                  <input
                    type="number"
                    aria-label="Audit retention days"
                    min={1}
                    max={365}
                    value={settings.privacy.retentionDays}
                    onChange={(e) => {
                      const val = Number(e.target.value)
                      if (Number.isInteger(val) && val >= 1 && val <= 365) {
                        runUpdate({ privacy: { retentionDays: val } })
                      }
                    }}
                    style={{ width: '90px' }}
                  />
                </div>
              </div>
            )}

            {activeSection === 'advanced' && (
              <div>
                <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
                  Advanced <span className="gb-badge">Read-only &amp; Reset</span>
                </h2>
                <div className="gb-setting-row">
                  <div>
                    <div>Daemon process</div>
                    <small className="gb-muted">
                      PID: {daemonHealth?.pid ?? 'N/A'} · Mode:{' '}
                      {daemonHealth?.runtimeMode ?? 'browser-preview'}
                    </small>
                  </div>
                  <span className="gb-badge">
                    {daemonHealth?.ok ? 'Healthy' : 'Browser preview'}
                  </span>
                </div>
                <div className="gb-setting-row">
                  <div>
                    <div>Reset application settings</div>
                    <small className="gb-muted">
                      Restore General, Appearance, Personalization, Permissions, and Privacy to
                      defaults.
                    </small>
                  </div>
                  {!confirmReset ? (
                    <button
                      type="button"
                      className="gb-btn-outline"
                      onClick={() => setConfirmReset(true)}
                    >
                      Reset to defaults
                    </button>
                  ) : (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        type="button"
                        className="gb-btn-outline"
                        onClick={() => setConfirmReset(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="gb-btn-accent"
                        onClick={() => {
                          setConfirmReset(false)
                          void onResetSettings().catch((err: unknown) => {
                            setErrorMsg(
                              err instanceof Error ? err.message : 'Failed to reset settings',
                            )
                          })
                        }}
                      >
                        Confirm reset
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeSection === 'memory' && (
              <MemorySettingsSection
                settings={settings}
                bots={bots}
                activeBotId={activeBotId}
                onUpdateSettings={onUpdateSettings}
              />
            )}

            {activeSection === 'knowledge' && (
              <KnowledgeSettingsSection
                settings={settings}
                bots={bots}
                activeBotId={activeBotId}
                onUpdateSettings={onUpdateSettings}
              />
            )}

            {activeSection === 'tools' && (
              <>
                <McpSettingsSection
                  settings={settings}
                  bots={bots}
                  activeBotId={activeBotId}
                  onUpdateSettings={onUpdateSettings}
                />
                <LocalSkillsSettingsSection />
              </>
            )}

            {activeSection === 'routines' && (
              <RoutinesSettingsSection
                bots={bots}
                teams={teams}
                activeBotId={activeBotId ?? null}
                isMockMode={daemonHealth?.runtimeMode !== 'codex'}
                onRefreshWorkspaceRoutines={onRefreshWorkspaceRoutines}
                onNavigateToBot={(bId) => {
                  onNavigateToBot?.(bId)
                  onClose()
                }}
                onNavigateToTeam={(tId) => {
                  onNavigateToTeam?.(tId)
                  onClose()
                }}
              />
            )}

            {activeSection === 'computer-use' && (
              <ComputerUseSettingsSection
                bots={bots}
                activeBotId={activeBotId ?? null}
                onOpenLiveViewer={(sId) => {
                  onClose()
                  onOpenComputerUseLiveViewer?.(sId)
                }}
              />
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
