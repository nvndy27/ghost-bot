import type { KeyboardEvent } from 'react'
import type { RuntimeSnapshot } from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import { BrainCircuit, Paperclip, ShieldCheck } from 'lucide-react'
import { useComposerTextareaHeight } from '../hooks/useComposerTextareaHeight.ts'
import { ComposerSendButton } from './ComposerSendButton.tsx'
import { MOCK_MODELS } from '../data/mockWorkspace.ts'
import type { WorkspaceBot } from '../types/workspace.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface ChatComposerProps {
  bot: WorkspaceBot
  draft: string
  isStreaming: boolean
  isMockMode: boolean
  runtimeSnapshot: RuntimeSnapshot | null
  onDraftChange: (value: string) => void
  onModelChange: (modelId: string) => void
  onEffortChange: (effort: string) => void
  onPermissionChange: (mode: PermissionMode) => void
  onSend: () => void
  onStop: () => void
}

export function ChatComposer({
  bot,
  draft,
  isStreaming,
  isMockMode,
  runtimeSnapshot,
  onDraftChange,
  onModelChange,
  onEffortChange,
  onPermissionChange,
  onSend,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useComposerTextareaHeight(draft)

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore Enter during IME composition (e.g. Vietnamese Telex/VNI, Japanese, Chinese).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) {
        onSend()
      }
    }
  }

  const isCodexBot = bot.runtimeId === 'codex'
  const verifiedModes = runtimeSnapshot?.verifiedPermissionModes ?? []
  const permissionVerified =
    isMockMode ||
    (isCodexBot &&
      bot.permission !== 'full-access' &&
      verifiedModes.includes(bot.permission as 'read-only' | 'ask-approval' | 'workspace'))
  const liveCodexReady =
    !isMockMode &&
    isCodexBot &&
    runtimeSnapshot?.status === 'available' &&
    runtimeSnapshot?.authStatus === 'connected' &&
    permissionVerified
  const availableModels =
    isMockMode || !isCodexBot ? [...MOCK_MODELS] : (runtimeSnapshot?.models ?? [])
  const activeModel =
    availableModels.find((m) => m.id === bot.modelId) ??
    availableModels[0] ??
    { id: bot.modelId, label: bot.modelId, efforts: ['low', 'medium', 'high'] }
  const canSend = (isMockMode || liveCodexReady) && !isStreaming && draft.trim().length > 0

  return (
    <div className="gb-composer-wrap">
      <form
        className="gb-composer"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSend) onSend()
        }}
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${bot.name}...`}
          aria-label={`Message ${bot.name}`}
          disabled={isStreaming}
        />
        <div className="gb-composer-footer">
          <div className="gb-composer-selectors">
            <IconButton
              label="Attach file (unavailable in Phase 1B)"
              title="Attachments (Phase 2)"
              disabled
            >
              <Paperclip size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>

            <select
              aria-label="Model"
              value={bot.modelId}
              disabled={isStreaming || availableModels.length === 0}
              onChange={(e) => onModelChange(e.target.value)}
            >
              {availableModels.length === 0 ? (
                <option value={bot.modelId}>No models discovered</option>
              ) : (
                <>
                  {!availableModels.some((m) => m.id === bot.modelId) && (
                    <option value={bot.modelId}>{bot.modelId} (Unavailable)</option>
                  )}
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </>
              )}
            </select>

            <div className="gb-composer-select-wrap">
              <BrainCircuit size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <select
                aria-label="Reasoning effort"
                value={bot.effort}
                disabled={isStreaming || availableModels.length === 0}
                onChange={(e) => onEffortChange(e.target.value)}
              >
                {activeModel.efforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff.charAt(0).toUpperCase() + eff.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            <div className="gb-composer-select-wrap">
              <ShieldCheck size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <select
                aria-label="Permission mode"
                value={bot.permission}
                disabled={isStreaming}
                onChange={(e) => onPermissionChange(e.target.value as PermissionMode)}
              >
                <option value="read-only">Read Only</option>
                <option
                  value="ask-approval"
                  disabled={!isMockMode && isCodexBot && !verifiedModes.includes('ask-approval')}
                >
                  Ask approval
                </option>
                <option
                  value="workspace"
                  disabled={!isMockMode && isCodexBot && !verifiedModes.includes('workspace')}
                >
                  Workspace Access
                </option>
                <option value="full-access" disabled>
                  Full Access (Disabled)
                </option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <small className="gb-muted" style={{ fontSize: '11.5px' }}>
              {isMockMode
                ? 'Offline mock mode'
                : liveCodexReady
                  ? `Codex (${bot.permission})`
                  : 'Codex unavailable'}
            </small>
            <ComposerSendButton canSend={canSend} stopping={isStreaming} onStop={onStop}
              sendLabel="Send message" stopLabel="Stop generation"
              disabledTitle="Unavailable for current mode/runtime" />
          </div>
        </div>
      </form>
    </div>
  )
}
