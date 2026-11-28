import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { AVATAR_COLOR_PALETTE, avatarPresets } from '@ghost-bot/avatar/presets'
import type { AvatarConfig, AvatarEyeStyle, PresetAvatarConfig } from '@ghost-bot/avatar/presets'
import type {
  CreateBotInput,
  RuntimeProviderCapabilitiesResponse,
  RuntimeProviderId,
  UpdateBotInput,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import { X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { AvatarStatus, WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { ProviderModelControls } from './ProviderModelControls.tsx'

const AVATAR_STATES: AvatarStatus[] = [
  'idle',
  'thinking',
  'working',
  'approval',
  'sleeping',
  'completed',
  'error',
]

const DEFAULT_PRESET_AVATAR: PresetAvatarConfig = {
  kind: 'preset',
  shape: 'ghost',
  color: '#418D79',
  eyes: 'classic',
  rotation: 0,
  animation: true,
}
type BotPermissionMode = Exclude<PermissionMode, 'full-access'>

export interface BotEditorModalProps {
  open: boolean
  mode: 'create' | 'edit'
  initialBot: WorkspaceBot | null
  isMockMode: boolean
  providerCapabilities: RuntimeProviderCapabilitiesResponse | null
  onRefreshProviderCapabilities: (providerId?: RuntimeProviderId) => Promise<void>
  canPickWorkspace: boolean
  canImportSvg: boolean
  onSaveCreate: (input: CreateBotInput) => Promise<void>
  onSaveEdit: (input: UpdateBotInput) => Promise<void>
  onDuplicate?: (id: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
  onImportSvg: (rawSvg: string, label?: string) => Promise<{ svgDataUrl: string; label?: string }>
  onPickWorkspace: () => Promise<string | null>
  onClose: () => void
}

export function BotEditorModal({
  open,
  mode,
  initialBot,
  isMockMode,
  providerCapabilities,
  onRefreshProviderCapabilities,
  canPickWorkspace,
  canImportSvg,
  onSaveCreate,
  onSaveEdit,
  onDuplicate,
  onDelete,
  onImportSvg,
  onPickWorkspace,
  onClose,
}: BotEditorModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState('')
  const [permission, setPermission] = useState<BotPermissionMode | ''>('')
  const [workspacePath, setWorkspacePath] = useState('~')
  const [avatar, setAvatar] = useState<AvatarConfig>(DEFAULT_PRESET_AVATAR)
  const [previewState, setPreviewState] = useState<AvatarStatus>('idle')
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initialBot) {
      setName(initialBot.name)
      setDescription(initialBot.description ?? '')
      setInstructions(initialBot.instructions)
      setRuntimeId(initialBot.runtimeId ?? '')
      setModelId(initialBot.modelId)
      setEffort(initialBot.effort)
      setPermission(initialBot.permission as BotPermissionMode)
      setWorkspacePath(initialBot.workspacePath)
      setAvatar(initialBot.avatar)
    } else {
      setName('')
      setDescription('')
      setInstructions('')
      setRuntimeId('')
      setModelId('')
      setEffort('')
      setPermission('')
      setWorkspacePath('~')
      setAvatar(DEFAULT_PRESET_AVATAR)
    }
    setPreviewState('idle')
    setDirty(false)
    setConfirmDiscard(false)
    setConfirmDelete(false)
    setSubmitting(false)
    setErrorMsg(null)
  }, [open, mode, initialBot])

  const attemptClose = () => {
    if (submitting) return
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  useModalDialog(open, modalRef, attemptClose)

  if (!open) return null

  const presetAvatar: PresetAvatarConfig =
    avatar.kind === 'custom' ? DEFAULT_PRESET_AVATAR : avatar

  const updatePreset = (patch: Partial<PresetAvatarConfig>) => {
    setDirty(true)
    setConfirmDiscard(false)
    setAvatar({ ...presetAvatar, kind: 'preset', ...patch })
  }

  const handleRandomize = () => {
    const randPreset = avatarPresets[Math.floor(Math.random() * avatarPresets.length)]
    const randColor = AVATAR_COLOR_PALETTE[Math.floor(Math.random() * AVATAR_COLOR_PALETTE.length)]
    const eyeOptions: AvatarEyeStyle[] = ['classic', 'round', 'happy', 'sleepy']
    const randEyes = eyeOptions[Math.floor(Math.random() * eyeOptions.length)]
    const randRot = Math.floor(Math.random() * 31) - 15
    updatePreset({
      shape: randPreset.id,
      color: randColor,
      eyes: randEyes,
      rotation: randRot,
    })
  }

  const handleResetAvatar = () => {
    setDirty(true)
    setAvatar(DEFAULT_PRESET_AVATAR)
  }

  const handleSvgFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErrorMsg(null)
    if (file.size > 32 * 1024) {
      setErrorMsg('SVG file exceeds the 32 KB limit.')
      return
    }
    setSubmitting(true)
    try {
      const rawSvg = await file.text()
      const res = await onImportSvg(rawSvg, file.name.slice(0, 60))
      setDirty(true)
      setAvatar({ kind: 'custom', svgDataUrl: res.svgDataUrl, label: res.label })
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Custom SVG import failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setErrorMsg('Bot name is required.')
      return
    }
    if (!workspacePath.trim()) {
      setErrorMsg('Workspace path is required.')
      return
    }
    const existing = mode === 'edit' ? initialBot : null
    const routingChanged = !existing || runtimeId !== existing.runtimeId || modelId !== existing.modelId ||
      effort !== existing.effort || permission !== existing.permission
    let selectedCatalogGeneration: string | undefined
    if (routingChanged) {
      const provider = providerCapabilities?.providers.find((candidate) => candidate.id === runtimeId)
      const model = provider?.models.find((candidate) => candidate.id === modelId)
      if (!runtimeId || !provider || provider.catalogState !== 'available' || !model) {
        setErrorMsg('Choose a provider and a currently discovered model before saving this routing change.')
        return
      }
      if ((model.efforts.length > 0 && !model.efforts.includes(effort)) || (model.efforts.length === 0 && effort !== '')) {
        setErrorMsg(model.efforts.length ? 'Choose a reasoning effort reported for this model.' : 'Clear the saved reasoning effort; this model reports no effort choices.')
        return
      }
      if (!permission || !model.permissionModes.includes(permission)) {
        setErrorMsg('Choose a permission mode reported as supported for this provider model.')
        return
      }
      if (runtimeId !== 'mock-offline' && !provider.catalogGeneration) {
        setErrorMsg('The provider catalog has no current identity. Refresh models and select again.')
        return
      }
      selectedCatalogGeneration = provider.catalogGeneration ?? undefined
    }
    setSubmitting(true)
    setErrorMsg(null)
    try {
      if (mode === 'create') {
        await onSaveCreate({
          name: trimmedName,
          description: description.trim(),
          instructions: instructions.trim(),
          avatar,
          runtimeId,
          modelId,
          effort,
          catalogGeneration: selectedCatalogGeneration,
          workspacePath: workspacePath.trim(),
          permission: permission as CreateBotInput['permission'],
        })
      } else if (initialBot) {
        await onSaveEdit({
          id: initialBot.id,
          patch: {
            name: trimmedName,
            description: description.trim(),
            instructions: instructions.trim(),
            avatar,
            ...(workspacePath.trim() === initialBot.workspacePath
              ? {}
              : { workspacePath: workspacePath.trim() }),
            ...(routingChanged ? {
              runtimeId,
              modelId,
              effort,
              permission: permission as BotPermissionMode,
              catalogGeneration: selectedCatalogGeneration,
            } : {}),
          },
        })
      }
      onClose()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save bot')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="gb-modal-backdrop" role="dialog" aria-modal="true" aria-label={mode === 'create' ? 'Create bot' : 'Edit bot'}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="gb-modal"
        style={{ maxWidth: '510px' }}
      >
        <div className="gb-modal-head">
          <strong>{mode === 'create' ? 'Create bot' : `Edit ${initialBot?.name ?? 'bot'}`}</strong>
          <IconButton label="Close bot editor" onClick={attemptClose}>
            <X size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          style={{ padding: '16px 20px', overflowY: 'auto', display: 'grid', gap: '12px' }}
        >
          {errorMsg && (
            <div
              role="alert"
              style={{
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

          {confirmDiscard && (
            <div
              role="alert"
              style={{
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
                fontSize: '13px',
              }}
            >
              <span>Discard unsaved changes?</span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  type="button"
                  className="gb-btn-outline"
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </button>
                <button type="button" className="gb-btn-accent" onClick={onClose}>
                  Discard
                </button>
              </div>
            </div>
          )}

          {/* Avatar Editor */}
          <div
            style={{
              background: 'var(--gb-surface)',
              borderRadius: '10px',
              padding: '14px',
              display: 'grid',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <BotAvatar
                config={avatar}
                status={previewState}
                size={76}
                label="Bot avatar live preview"
              />
              <div style={{ flex: 1, display: 'grid', gap: '8px' }}>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={avatar.kind !== 'custom' ? 'gb-btn-accent' : 'gb-btn-outline'}
                    onClick={() => updatePreset({})}
                  >
                    Preset Avatar
                  </button>
                  <label
                    className="gb-btn-outline"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      cursor: canImportSvg ? 'pointer' : 'not-allowed',
                      opacity: canImportSvg ? 1 : 0.5,
                    }}
                  >
                    <span>Import SVG</span>
                    <input
                      type="file"
                      accept=".svg,image/svg+xml"
                      disabled={!canImportSvg}
                      onChange={(e) => void handleSvgFileChange(e)}
                      style={{ display: 'none' }}
                      aria-label="Import custom SVG avatar"
                    />
                  </label>
                  {avatar.kind !== 'custom' && (
                    <>
                      <button type="button" className="gb-btn-outline" onClick={handleRandomize}>
                        Randomize
                      </button>
                      <button type="button" className="gb-btn-outline" onClick={handleResetAvatar}>
                        Reset
                      </button>
                    </>
                  )}
                </div>

                {avatar.kind === 'custom' ? (
                  <small className="gb-muted">
                    Custom SVG renders as a static sandboxed image (7-state eye animations apply to
                    native presets only).
                  </small>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <small className="gb-muted">State preview:</small>
                    {AVATAR_STATES.map((st) => (
                      <button
                        key={st}
                        type="button"
                        className={previewState === st ? 'gb-btn-accent' : 'gb-btn-outline'}
                        style={{ padding: '2px 7px', fontSize: '11px' }}
                        onClick={() => setPreviewState(st)}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {avatar.kind !== 'custom' && (
              <>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
                    gap: '6px',
                  }}
                >
                  {avatarPresets.map((p) => {
                    const selected = presetAvatar.shape === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-label={`Shape ${p.name}`}
                        aria-pressed={selected}
                        onClick={() => updatePreset({ shape: p.id })}
                        style={{
                          border: selected
                            ? '2px solid var(--gb-accent)'
                            : '1px solid var(--gb-border)',
                          padding: '6px',
                          display: 'flex',
                          justifyContent: 'center',
                        }}
                      >
                        <BotAvatar
                          config={{ ...presetAvatar, shape: p.id, animation: false }}
                          size={28}
                        />
                      </button>
                    )
                  })}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {AVATAR_COLOR_PALETTE.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Color ${hex}`}
                      aria-pressed={presetAvatar.color.toLowerCase() === hex.toLowerCase()}
                      onClick={() => updatePreset({ color: hex })}
                      style={{
                        width: '22px',
                        height: '22px',
                        borderRadius: '50%',
                        padding: 0,
                        background: hex,
                        border:
                          presetAvatar.color.toLowerCase() === hex.toLowerCase()
                            ? '2px solid var(--gb-text)'
                            : '1px solid var(--gb-border)',
                      }}
                    />
                  ))}
                </div>

                <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
                    <span>Eyes</span>
                    <select
                      aria-label="Avatar eyes"
                      value={presetAvatar.eyes}
                      onChange={(e) => updatePreset({ eyes: e.target.value as AvatarEyeStyle })}
                    >
                      <option value="classic">Classic</option>
                      <option value="round">Round</option>
                      <option value="happy">Happy</option>
                      <option value="sleepy">Sleepy</option>
                    </select>
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
                    <span>Tilt ({presetAvatar.rotation}°)</span>
                    <input
                      type="range"
                      aria-label="Avatar rotation"
                      min={-20}
                      max={20}
                      value={presetAvatar.rotation}
                      onChange={(e) => updatePreset({ rotation: Number(e.target.value) })}
                    />
                  </label>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
                    <input
                      type="checkbox"
                      checked={presetAvatar.animation}
                      onChange={(e) => updatePreset({ animation: e.target.checked })}
                    />
                    <span>Animate</span>
                  </label>
                </div>
              </>
            )}
          </div>

          <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
            <span>Bot name *</span>
            <input
              type="text"
              required
              maxLength={60}
              value={name}
              onChange={(e) => {
                setDirty(true)
                setName(e.target.value)
              }}
              placeholder="e.g. Security Auditor"
            />
          </label>

          <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
            <span>Short description</span>
            <input
              type="text"
              maxLength={160}
              value={description}
              onChange={(e) => {
                setDirty(true)
                setDescription(e.target.value)
              }}
              placeholder="Role summary shown in configuration"
            />
          </label>

          <label style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
            <span>Instructions</span>
            <textarea
              rows={2}
              maxLength={4000}
              value={instructions}
              onChange={(e) => {
                setDirty(true)
                setInstructions(e.target.value)
              }}
              placeholder="System instructions and behavior"
            />
          </label>

          {mode === 'edit' && initialBot?.runtimeId === 'mock-offline' && !isMockMode && (
            <div className="gb-card" role="status" style={{ fontSize: '12.5px' }}>
              This bot is configured for Offline Mock. Its identity and conversations are preserved.
              Choose a discovered real provider and model below to change its execution configuration.
            </div>
          )}
          <ProviderModelControls
            capabilities={providerCapabilities}
            isMockMode={isMockMode}
            runtimeId={runtimeId}
            modelId={modelId}
            effort={effort}
            permission={permission}
            onRuntimeChange={(value) => {
              setDirty(true)
              setRuntimeId(value)
              setModelId('')
              setEffort('')
              setPermission('')
            }}
            onModelChange={(value) => { setDirty(true); setModelId(value) }}
            onEffortChange={(value) => { setDirty(true); setEffort(value) }}
            onPermissionChange={(value) => { setDirty(true); setPermission(value) }}
            onRefreshProviderCapabilities={onRefreshProviderCapabilities}
            disabled={submitting}
          />

          <div style={{ display: 'grid', gap: '4px', fontSize: '13px' }}>
            <span>Workspace path</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                style={{ flex: 1 }}
                value={workspacePath}
                onChange={(e) => {
                  setDirty(true)
                  setWorkspacePath(e.target.value)
                }}
              />
              {canPickWorkspace && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  onClick={() => {
                    void onPickWorkspace().then((chosen) => {
                      if (chosen) {
                        setDirty(true)
                        setWorkspacePath(chosen)
                      }
                    })
                  }}
                >
                  Choose folder
                </button>
              )}
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              marginTop: '4px',
              paddingTop: '12px',
              borderTop: '1px solid var(--gb-border)',
            }}
          >
            <div style={{ display: 'flex', gap: '6px' }}>
              {mode === 'edit' && initialBot && onDuplicate && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  disabled={submitting}
                  onClick={() => {
                    setSubmitting(true)
                    void onDuplicate(initialBot.id)
                      .then(() => onClose())
                      .catch((err) =>
                        setErrorMsg(err instanceof Error ? err.message : 'Duplicate failed'),
                      )
                      .finally(() => setSubmitting(false))
                  }}
                >
                  Duplicate
                </button>
              )}
              {mode === 'edit' && initialBot && onDelete && !confirmDelete && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ color: 'var(--gb-danger)' }}
                  disabled={submitting}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
              )}
              {mode === 'edit' && initialBot && onDelete && confirmDelete && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ borderColor: 'var(--gb-danger)', color: 'var(--gb-danger)' }}
                  disabled={submitting}
                  onClick={() => {
                    setSubmitting(true)
                    void onDelete(initialBot.id)
                      .then(() => onClose())
                      .catch((err) =>
                        setErrorMsg(err instanceof Error ? err.message : 'Delete failed'),
                      )
                      .finally(() => setSubmitting(false))
                  }}
                >
                  Confirm delete
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button type="button" className="gb-btn-outline" onClick={attemptClose}>
                Cancel
              </button>
              <button type="submit" className="gb-btn-accent" disabled={submitting}>
                {submitting ? 'Saving...' : mode === 'create' ? 'Create bot' : 'Save changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
