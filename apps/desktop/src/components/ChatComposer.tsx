import { useEffect, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type {
  RuntimeProviderCapabilitiesResponse,
  RuntimeProviderId,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import { Paperclip } from 'lucide-react'
import { useComposerTextareaHeight } from '../hooks/useComposerTextareaHeight.ts'
import { providerReadinessLabel } from '../state/providerReadiness.ts'
import type { WorkspaceBot } from '../types/workspace.ts'
import { ComposerSendButton } from './ComposerSendButton.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { ProviderModelControls } from './ProviderModelControls.tsx'

type BotPermissionMode = Exclude<PermissionMode, 'full-access'>

export interface ChatComposerProps {
  bot: WorkspaceBot
  draft: string
  isStreaming: boolean
  isMockMode: boolean
  providerCapabilities: RuntimeProviderCapabilitiesResponse | null
  onDraftChange: (value: string) => void
  onApplyProviderConfiguration: (input: {
    runtimeId: string
    modelId: string
    effort: string
    permission: BotPermissionMode
    catalogGeneration?: string
  }) => Promise<void>
  onRefreshProviderCapabilities: (providerId?: RuntimeProviderId) => Promise<void>
  onSend: () => void
  onStop: () => void
}

export function ChatComposer({
  bot,
  draft,
  isStreaming,
  isMockMode,
  providerCapabilities,
  onDraftChange,
  onApplyProviderConfiguration,
  onRefreshProviderCapabilities,
  onSend,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useComposerTextareaHeight(draft)
  const [runtimeId, setRuntimeId] = useState(bot.runtimeId ?? '')
  const [modelId, setModelId] = useState(bot.modelId)
  const [effort, setEffort] = useState(bot.effort)
  const [permission, setPermission] = useState<BotPermissionMode | ''>(bot.permission as BotPermissionMode)
  const [savingConfiguration, setSavingConfiguration] = useState(false)
  const [configurationError, setConfigurationError] = useState<string | null>(null)

  useEffect(() => {
    setRuntimeId(bot.runtimeId ?? '')
    setModelId(bot.modelId)
    setEffort(bot.effort)
    setPermission(bot.permission as BotPermissionMode)
    setConfigurationError(null)
  }, [bot.id, bot.runtimeId, bot.modelId, bot.effort, bot.permission, bot.updatedAt])

  const readiness = providerCapabilities?.selectedBot?.botId === bot.id
    ? providerCapabilities.selectedBot
    : null
  const pendingProvider = providerCapabilities?.providers.find((item) => item.id === runtimeId)
  const pendingModel = pendingProvider?.models.find((item) => item.id === modelId)
  const configurationChanged = runtimeId !== bot.runtimeId || modelId !== bot.modelId ||
    effort !== bot.effort || permission !== bot.permission
  const selectionValid = Boolean(
    pendingProvider && pendingProvider.catalogState === 'available' && pendingModel && permission &&
    pendingModel.permissionModes.includes(permission) &&
    (pendingModel.efforts.length === 0 ? effort === '' : pendingModel.efforts.includes(effort)) &&
    (runtimeId === 'mock-offline' || pendingProvider.catalogGeneration),
  )
  const canSend = Boolean(readiness?.ready && !configurationChanged && !isStreaming && draft.trim())
  const readyReason = configurationChanged
    ? 'Apply the selected provider and model before sending.'
    : readiness?.reason ?? 'Provider readiness is being checked by the daemon.'

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore Enter during IME composition (e.g. Vietnamese Telex/VNI, Japanese, Chinese).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  const applyConfiguration = async () => {
    if (!selectionValid || !pendingProvider || !pendingModel || !permission || savingConfiguration) return
    setSavingConfiguration(true)
    setConfigurationError(null)
    try {
      await onApplyProviderConfiguration({
        runtimeId,
        modelId,
        effort,
        permission,
        catalogGeneration: pendingProvider.catalogGeneration ?? undefined,
      })
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : 'Provider configuration could not be saved.')
    } finally {
      setSavingConfiguration(false)
    }
  }

  return (
    <div className="gb-composer-wrap">
      <form
        className="gb-composer"
        onSubmit={(event) => {
          event.preventDefault()
          if (canSend) onSend()
        }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${bot.name}...`}
          aria-label={`Message ${bot.name}`}
          disabled={isStreaming}
        />
        <div className="gb-composer-footer" style={{ alignItems: 'flex-end' }}>
          <div className="gb-composer-selectors" style={{ flex: '1 1 auto', minWidth: 0, alignItems: 'flex-end' }}>
            <IconButton
              label="Attach file (unavailable in Phase 1B)"
              title="Attachments (Phase 2)"
              disabled
            >
              <Paperclip size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
            <div style={{ minWidth: 'min(460px, 100%)', flex: '1 1 320px' }}>
              <ProviderModelControls
                capabilities={providerCapabilities}
                isMockMode={isMockMode}
                runtimeId={runtimeId}
                modelId={modelId}
                effort={effort}
                permission={permission}
                onRuntimeChange={(value) => {
                  setRuntimeId(value)
                  setModelId('')
                  setEffort('')
                  setPermission('')
                  setConfigurationError(null)
                }}
                onModelChange={setModelId}
                onEffortChange={setEffort}
                onPermissionChange={setPermission}
                onRefreshProviderCapabilities={onRefreshProviderCapabilities}
                disabled={isStreaming || savingConfiguration}
                compact
              />
              {configurationChanged && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  onClick={() => void applyConfiguration()}
                  disabled={!selectionValid || savingConfiguration || isStreaming}
                  style={{ marginTop: '6px', fontSize: '11px', padding: '3px 9px' }}
                >
                  {savingConfiguration ? 'Saving…' : 'Apply provider settings'}
                </button>
              )}
              {configurationError && <div role="alert" style={{ color: 'var(--gb-danger)', fontSize: '11px', marginTop: '4px' }}>{configurationError}</div>}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' }}>
            <small className="gb-muted" title={readyReason} style={{ fontSize: '11.5px', maxWidth: 180 }}>
              {configurationChanged
                ? 'Configuration not applied'
                : readiness ? providerReadinessLabel(readiness) : 'Checking provider…'}
            </small>
            <ComposerSendButton
              canSend={canSend}
              stopping={isStreaming}
              onStop={onStop}
              sendLabel="Send message"
              stopLabel="Stop generation"
              disabledTitle={readyReason}
            />
          </div>
        </div>
      </form>
    </div>
  )
}
