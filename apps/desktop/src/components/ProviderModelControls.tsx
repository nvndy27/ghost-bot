import { useState } from 'react'
import type {
  RuntimeProviderCapabilitiesResponse,
  RuntimeProviderId,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'

type BotPermissionMode = Exclude<PermissionMode, 'full-access'>

export interface ProviderModelControlsProps {
  capabilities: RuntimeProviderCapabilitiesResponse | null
  isMockMode: boolean
  runtimeId: string
  modelId: string
  effort: string
  permission: BotPermissionMode | ''
  onRuntimeChange: (runtimeId: string) => void
  onModelChange: (modelId: string) => void
  onEffortChange: (effort: string) => void
  onPermissionChange: (permission: BotPermissionMode | '') => void
  onRefreshProviderCapabilities: (providerId?: RuntimeProviderId) => Promise<void>
  disabled?: boolean
  compact?: boolean
}

function catalogLabel(state: string | undefined): string {
  switch (state) {
    case 'available': return 'Models discovered'
    case 'stale': return 'Showing a previously discovered catalog'
    case 'not-authorized': return 'Provider discovery needs explicit authorization'
    case 'failed': return 'Model discovery failed'
    case 'not-discovered': return 'Models have not been discovered'
    default: return 'No models are currently available'
  }
}

export function ProviderModelControls({
  capabilities,
  isMockMode,
  runtimeId,
  modelId,
  effort,
  permission,
  onRuntimeChange,
  onModelChange,
  onEffortChange,
  onPermissionChange,
  onRefreshProviderCapabilities,
  disabled = false,
  compact = false,
}: ProviderModelControlsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const provider = capabilities?.providers.find((item) => item.id === runtimeId)
  const model = provider?.models.find((item) => item.id === modelId)
  const visibleProviders = (capabilities?.providers ?? []).filter((item) =>
    item.id !== 'mock-offline' || isMockMode || runtimeId === 'mock-offline',
  )
  const apiDiscovery = provider?.kind === 'api'
  const modelMissing = Boolean(modelId && provider && !model)
  const gridColumns = compact ? 'minmax(98px, .9fr) minmax(120px, 1.3fr)' : '1fr 1fr 1fr 1fr'
  const fieldStyle = { display: 'grid', gap: '4px', fontSize: compact ? '11.5px' : '12.5px', minWidth: 0 }

  const refresh = async (explicitDiscovery = false) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRefreshProviderCapabilities(
        explicitDiscovery && apiDiscovery ? (provider?.id as RuntimeProviderId) : undefined,
      )
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Provider discovery failed. Check provider settings and retry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="group"
      aria-label="Provider model configuration"
      data-testid="provider-model-controls"
      style={{ display: 'grid', gridTemplateColumns: gridColumns, gap: compact ? '6px' : '8px', alignItems: 'end', minWidth: 0 }}
    >
      <label style={fieldStyle}>
        <span>Provider</span>
        <select
          aria-label="Bot provider"
          data-testid="provider-select"
          value={runtimeId}
          disabled={disabled || !capabilities}
          onChange={(event) => onRuntimeChange(event.target.value)}
        >
          <option value="">Choose a provider…</option>
          {runtimeId && !visibleProviders.some((item) => item.id === runtimeId) && (
            <option value={runtimeId}>Unknown existing provider · configure explicitly</option>
          )}
          {visibleProviders.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id === 'mock-offline' && !isMockMode ? `${item.label} (existing bot)` : item.label}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldStyle}>
        <span>Model</span>
        <select
          aria-label="Bot model"
          data-testid="bot-model-select"
          value={modelId}
          disabled={disabled || !provider || provider.catalogState !== 'available' || provider.models.length === 0}
          onChange={(event) => {
            const next = provider?.models.find((item) => item.id === event.target.value)
            onModelChange(event.target.value)
            onEffortChange('')
            if (!next?.permissionModes.includes(permission as BotPermissionMode)) onPermissionChange('')
          }}
        >
          {!modelId && <option value="">{provider?.models.length ? 'Choose a model…' : 'No discovered models'}</option>}
          {modelMissing && <option value={modelId}>{modelId} · unavailable in current catalog</option>}
          {(provider?.models ?? []).map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>
      </label>

      {compact && <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ ...fieldStyle, flex: '1 1 110px' }}>
          <span>Reasoning effort</span>
          <select
            aria-label="Reasoning effort"
            data-testid="bot-effort-select"
            value={effort}
            disabled={disabled || !model || (model.efforts.length === 0 && effort === '')}
            onChange={(event) => onEffortChange(event.target.value)}
          >
            {model?.efforts.length ? <option value="">Choose effort…</option> : <option value="">{effort ? 'Clear unsupported saved effort' : 'Not reported by provider'}</option>}
            {effort && !model?.efforts.includes(effort) && <option value={effort}>{effort} · unsupported saved value</option>}
            {(model?.efforts ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label style={{ ...fieldStyle, flex: '1 1 120px' }}>
          <span>Permission</span>
          <select
            aria-label="Permission mode"
            value={permission}
            disabled={disabled || !model}
            onChange={(event) => onPermissionChange(event.target.value as BotPermissionMode | '')}
          >
            {!permission && <option value="">Choose permission…</option>}
            {permission && !model?.permissionModes.includes(permission) && <option value={permission}>{permission} · unavailable</option>}
            {(model?.permissionModes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </div>}

      {!compact && <>
        <label style={fieldStyle}>
          <span>Reasoning effort</span>
          <select
            aria-label="Reasoning effort"
            data-testid="bot-effort-select"
            value={effort}
            disabled={disabled || !model || (model.efforts.length === 0 && effort === '')}
            onChange={(event) => onEffortChange(event.target.value)}
          >
            {model?.efforts.length ? <option value="">Choose effort…</option> : <option value="">{effort ? 'Clear unsupported saved effort' : 'Not reported'}</option>}
            {effort && !model?.efforts.includes(effort) && <option value={effort}>{effort} · unsupported saved value</option>}
            {(model?.efforts ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>

        <label style={fieldStyle}>
          <span>Permission</span>
          <select
            aria-label="Permission mode"
            value={permission}
            disabled={disabled || !model}
            onChange={(event) => onPermissionChange(event.target.value as BotPermissionMode | '')}
          >
            {!permission && <option value="">Choose permission…</option>}
            {permission && !model?.permissionModes.includes(permission) && <option value={permission}>{permission} · unavailable</option>}
            {(model?.permissionModes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </>}

      <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
        <span className="gb-muted" style={{ minWidth: 0, flex: '1 1 180px', fontSize: compact ? '10.5px' : '11.5px' }}>
          {provider ? `${provider.accountLabel ?? provider.authenticationDetail} · ${catalogLabel(provider.catalogState)} · ${provider.executionReady ? 'provider execution authorized' : provider.executionReason}` : 'Choose a provider to inspect its actual model catalog.'}
        </span>
        {provider && provider.id !== 'mock-offline' && (
          <button
            type="button"
            className="gb-btn-outline"
            disabled={disabled || busy}
            onClick={() => void refresh(apiDiscovery)}
            style={{ fontSize: compact ? '10.5px' : '11px', padding: '3px 8px' }}
          >
            {busy ? 'Checking…' : apiDiscovery ? 'Discover models' : 'Refresh models'}
          </button>
        )}
        {error && <span role="alert" style={{ color: 'var(--gb-danger)', fontSize: '11px' }}>{error}</span>}
      </div>
    </div>
  )
}
