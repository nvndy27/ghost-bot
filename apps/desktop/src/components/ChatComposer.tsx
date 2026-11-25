import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import { MOCK_MODELS } from '../data/mockWorkspace.ts'
import type { WorkspaceBot } from '../types/workspace.ts'

export interface ChatComposerProps {
  bot: WorkspaceBot
  draft: string
  isStreaming: boolean
  isMockMode: boolean
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
  onDraftChange,
  onModelChange,
  onEffortChange,
  onPermissionChange,
  onSend,
  onStop,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [draft])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore Enter during IME composition (e.g. Vietnamese Telex/VNI, Japanese, Chinese).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isStreaming && draft.trim() && isMockMode) {
        onSend()
      }
    }
  }

  const activeModel = MOCK_MODELS.find((m) => m.id === bot.modelId) ?? MOCK_MODELS[0]
  const canSend = isMockMode && !isStreaming && draft.trim().length > 0

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
          rows={2}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${bot.name}...`}
          aria-label={`Message ${bot.name}`}
          disabled={isStreaming}
        />
        <div className="gb-composer-footer">
          <div className="gb-composer-selectors">
            <button
              type="button"
              disabled
              title="Attachments (Phase 2)"
              aria-label="Attach file (unavailable in Phase 1B)"
              style={{ padding: '4px 6px', fontSize: '13px' }}
            >
              📎
            </button>

            <select
              aria-label="Model"
              value={isMockMode ? bot.modelId : 'unavailable'}
              disabled={!isMockMode || isStreaming}
              onChange={(e) => onModelChange(e.target.value)}
            >
              {isMockMode ? (
                MOCK_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))
              ) : (
                <option value="unavailable">Models connect in Phase 2</option>
              )}
            </select>

            <select
              aria-label="Reasoning effort"
              value={bot.effort}
              disabled={!isMockMode || isStreaming}
              onChange={(e) => onEffortChange(e.target.value)}
            >
              {activeModel.efforts.map((eff) => (
                <option key={eff} value={eff}>
                  {eff.charAt(0).toUpperCase() + eff.slice(1)}
                </option>
              ))}
            </select>

            <select
              aria-label="Permission mode"
              value={bot.permission}
              disabled={isStreaming}
              onChange={(e) => onPermissionChange(e.target.value as PermissionMode)}
            >
              <option value="read-only">Read Only</option>
              <option value="ask-approval">Ask approval</option>
              <option value="workspace">Workspace Access</option>
              <option value="full-access" disabled>
                Full Access (Disabled)
              </option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <small className="gb-muted" style={{ fontSize: '11.5px' }}>
              {isMockMode ? 'Offline mock mode' : 'Chat execution opens in Phase 2'}
            </small>
            {isStreaming ? (
              <button
                type="button"
                className="gb-send-btn"
                onClick={onStop}
                title="Stop generation"
                aria-label="Stop generation"
              >
                ■
              </button>
            ) : (
              <button
                type="submit"
                className="gb-send-btn"
                disabled={!canSend}
                title={isMockMode ? 'Send message' : 'Available in Phase 2'}
                aria-label="Send message"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}
