import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { AVATAR_COLOR_PALETTE, avatarPresets } from '@ghost-bot/avatar/presets'
import type { AvatarConfig, AvatarEyeStyle, PresetAvatarConfig } from '@ghost-bot/avatar/presets'
import type { CreateBotInput, UpdateBotInput } from '@ghost-bot/shared-types/ipc'
import { MOCK_MODELS } from '../data/mockWorkspace.ts'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { AvatarStatus, WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

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

export interface BotEditorModalProps {
  open: boolean
  mode: 'create' | 'edit'
  initialBot: WorkspaceBot | null
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
  const [runtimeId, setRuntimeId] = useState<'mock-offline' | 'codex' | 'openclaw' | 'ollama'>(
    'mock-offline',
  )
  const [ollamaStatus, setOllamaStatus] = useState<
    import('@ghost-bot/shared-types/ipc').OllamaStatusDto | null
  >(null)
  const [modelId, setModelId] = useState<string>(MOCK_MODELS[0].id)
  const [effort, setEffort] = useState<'low' | 'medium' | 'high'>('medium')
  const [permission, setPermission] = useState<'read-only' | 'ask-approval' | 'workspace'>(
    'ask-approval',
  )
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
    if (window.ghostBot?.getOllamaStatus) {
      void window.ghostBot
        .getOllamaStatus()
        .then(setOllamaStatus)
        .catch(() => setOllamaStatus(null))
    }
    if (mode === 'edit' && initialBot) {
      setName(initialBot.name)
      setDescription(initialBot.description ?? '')
      setInstructions(initialBot.instructions)
      setRuntimeId(
        initialBot.runtimeId === 'codex' ||
          initialBot.runtimeId === 'openclaw' ||
          initialBot.runtimeId === 'ollama'
          ? initialBot.runtimeId
          : 'mock-offline',
      )
      setModelId(initialBot.modelId)
      setEffort(
        initialBot.effort === 'low' || initialBot.effort === 'high' ? initialBot.effort : 'medium',
      )
      setPermission(
        initialBot.permission === 'full-access' ? 'ask-approval' : initialBot.permission,
      )
      setWorkspacePath(initialBot.workspacePath)
      setAvatar(initialBot.avatar)
    } else {
      setName('')
      setDescription('')
      setInstructions('')
      setModelId(MOCK_MODELS[0].id)
      setEffort('medium')
      setPermission('ask-approval')
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
          workspacePath: workspacePath.trim(),
          permission,
        })
      } else if (initialBot) {
        await onSaveEdit({
          id: initialBot.id,
          patch: {
            name: trimmedName,
            description: description.trim(),
            instructions: instructions.trim(),
            avatar,
            runtimeId,
            modelId,
            effort,
            workspacePath: workspacePath.trim(),
            permission,
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
        style={{ maxWidth: '640px' }}
      >
        <div className="gb-modal-head">
          <strong>{mode === 'create' ? 'Create bot' : `Edit ${initialBot?.name ?? 'bot'}`}</strong>
          <button type="button" onClick={attemptClose} aria-label="Close bot editor">
            ×
          </button>
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

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
            <label style={{ display: 'grid', gap: '4px', fontSize: '12.5px' }}>
              <span>Runtime</span>
              <select
                data-testid="bot-runtime-select"
                value={runtimeId}
                onChange={(e) => {
                  const next = e.target.value as 'mock-offline' | 'codex' | 'openclaw' | 'ollama'
                  setDirty(true)
                  setRuntimeId(next)
                  if (next === 'ollama') {
                    setPermission('read-only')
                    if (ollamaStatus && ollamaStatus.models.length > 0) {
                      setModelId(ollamaStatus.models[0].id)
                    }
                  }
                }}
              >
                <option value="mock-offline">Mock Offline</option>
                <option value="codex">Codex (ChatGPT)</option>
                <option value="openclaw">OpenClaw Gateway</option>
                <option value="ollama">Ollama Local</option>
              </select>
            </label>

            <label style={{ display: 'grid', gap: '4px', fontSize: '12.5px' }}>
              <span>{runtimeId === 'ollama' ? 'Model (Ollama)' : 'Model (mock)'}</span>
              <select
                data-testid="bot-model-select"
                value={modelId}
                onChange={(e) => {
                  setDirty(true)
                  setModelId(e.target.value)
                }}
              >
                {runtimeId === 'ollama' ? (
                  ollamaStatus && ollamaStatus.models.length > 0 ? (
                    ollamaStatus.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.parameterSize ? ` (${m.parameterSize})` : ''}
                      </option>
                    ))
                  ) : (
                    <option value={modelId}>
                      {ollamaStatus?.available
                        ? 'No local Ollama models installed'
                        : 'Ollama unavailable (127.0.0.1:11434)'}
                    </option>
                  )
                ) : (
                  MOCK_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label style={{ display: 'grid', gap: '4px', fontSize: '12.5px' }}>
              <span>Effort</span>
              <select
                value={effort}
                onChange={(e) => {
                  setDirty(true)
                  setEffort(e.target.value as 'low' | 'medium' | 'high')
                }}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>

            <label style={{ display: 'grid', gap: '4px', fontSize: '12.5px' }}>
              <span>Permission</span>
              <select
                value={permission}
                onChange={(e) => {
                  setDirty(true)
                  setPermission(e.target.value as 'read-only' | 'ask-approval' | 'workspace')
                }}
              >
                <option value="read-only">Read Only</option>
                <option value="ask-approval">Ask approval</option>
                <option value="workspace">Workspace Access</option>
                <option value="full-access" disabled>
                  Full Access (Disabled)
                </option>
              </select>
            </label>
          </div>

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
