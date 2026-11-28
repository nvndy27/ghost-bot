import { useEffect, useRef, useState } from 'react'
import type { SelectedBotReadiness, SessionRecord } from '@ghost-bot/shared-types/ipc'
import {
  Archive,
  Check,
  CheckCheck,
  Ellipsis,
  History,
  PanelLeft,
  PanelRight,
  Pencil,
  SquarePen,
  X,
} from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { providerReadinessLabel } from '../state/providerReadiness.ts'

export interface ChatHeaderProps {
  bot: WorkspaceBot | null
  leftCollapsed: boolean
  rightCollapsed: boolean
  isMockMode: boolean
  selectedBotReadiness?: SelectedBotReadiness | null
  sessions?: SessionRecord[]
  activeSessionId?: string | null
  onSelectSession?: (sessionId: string) => void
  onNewChat?: () => void
  onRenameSession?: (sessionId: string, title: string) => Promise<void> | void
  onArchiveSession?: (sessionId: string) => Promise<void> | void
  onMarkSessionRead?: (sessionId: string) => Promise<void> | void
  onEditBot: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
}

function formatRunIndicator(s: SessionRecord): string | null {
  if (s.activeRunId) return 'Running'
  if (s.unread) {
    if (s.lastCompletedRunStatus === 'failed') return 'Failed'
    if (s.lastCompletedRunStatus === 'awaiting_approval') return 'Approval'
    if (s.lastCompletedRunStatus === 'completed') return 'Done'
    return 'Unread'
  }
  return null
}

export function ChatHeader({
  bot,
  leftCollapsed,
  rightCollapsed,
  isMockMode,
  selectedBotReadiness,
  sessions,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onRenameSession,
  onArchiveSession,
  onMarkSessionRead,
  onEditBot,
  onToggleLeft,
  onToggleRight,
}: ChatHeaderProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setPopoverOpen(false)
    setEditingId(null)
  }, [bot?.id])

  useEffect(() => {
    if (!popoverOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editingId) {
          setEditingId(null)
        } else {
          setPopoverOpen(false)
        }
      }
    }
    const onPointerDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
        setEditingId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [popoverOpen, editingId])

  const unreadSessionsCount = (sessions ?? []).filter(
    (s) => s.unread && s.id !== activeSessionId,
  ).length

  const submitRename = async (sessionId: string) => {
    const trimmed = editTitle.trim()
    if (!trimmed || !onRenameSession) {
      setEditingId(null)
      return
    }
    setBusyId(sessionId)
    try {
      await onRenameSession(sessionId, trimmed)
      setEditingId(null)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <header className="gb-chat-header">
      {leftCollapsed && (
        <IconButton
          label="Expand left sidebar"
          onClick={onToggleLeft}
          pressed={!leftCollapsed}
        >
          <PanelLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
      )}
      {bot ? (
        <>
          <BotAvatar
            config={bot.avatar}
            status={bot.avatarStatus}
            size={32}
            label={`${bot.name} avatar`}
          />
          <strong className="gb-chat-header-title" title={bot.name}>{bot.name}</strong>
          <span className="gb-badge">
            {selectedBotReadiness?.botId === bot.id
              ? providerReadinessLabel(selectedBotReadiness)
              : isMockMode ? 'Checking offline demo' : 'Checking provider'}
          </span>
          <div style={{ flex: 1 }} />
          {sessions && sessions.length > 0 && onSelectSession && (
            <div className="gb-conv-popover-wrap" ref={wrapRef}>
              <select
                aria-label="Conversation session"
                value={activeSessionId ?? sessions[0]?.id ?? ''}
                onChange={(e) => onSelectSession(e.target.value)}
                style={{
                  maxWidth: 190,
                  height: 28,
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid var(--gb-border)',
                  background: 'var(--gb-surface-elevated)',
                  color: 'var(--gb-text-primary)',
                  padding: '0 8px',
                }}
              >
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.unread && s.id !== activeSessionId ? `• ${s.title}` : s.title}
                  </option>
                ))}
              </select>
              <IconButton
                label="Manage conversations"
                title="Manage conversations"
                pressed={popoverOpen}
                active={popoverOpen}
                onClick={() => setPopoverOpen((v) => !v)}
              >
                <History size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </IconButton>
              {unreadSessionsCount > 0 && (
                <span
                  className="gb-unread-pill"
                  aria-label={`${unreadSessionsCount} unread conversation${unreadSessionsCount === 1 ? '' : 's'}`}
                >
                  {unreadSessionsCount}
                </span>
              )}
              {popoverOpen && (
                <div
                  className="gb-conv-popover"
                  role="dialog"
                  aria-label="Conversations"
                >
                  <div className="gb-conv-popover-head">
                    <span>Conversations ({sessions.length})</span>
                    {onNewChat && (
                      <button
                        type="button"
                        className="gb-btn-outline gb-icon-inline"
                        style={{ fontSize: 11.5, padding: '2px 8px' }}
                        onClick={() => {
                          onNewChat()
                          setPopoverOpen(false)
                        }}
                      >
                        <SquarePen size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        <span>New</span>
                      </button>
                    )}
                  </div>
                  <div className="gb-conv-list" role="list">
                    {sessions.map((s) => {
                      const isActive = s.id === activeSessionId
                      const isEditing = editingId === s.id
                      const indicator = formatRunIndicator(s)
                      const isBusy = busyId === s.id
                      return (
                        <div
                          key={s.id}
                          role="listitem"
                          className={`gb-conv-item${isActive ? ' active' : ''}`}
                          data-session-id={s.id}
                        >
                          {isEditing ? (
                            <form
                              style={{ display: 'flex', flex: 1, gap: 4, alignItems: 'center' }}
                              onSubmit={(e) => {
                                e.preventDefault()
                                void submitRename(s.id)
                              }}
                            >
                              <input
                                type="text"
                                aria-label="Rename conversation title"
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                autoFocus
                                maxLength={120}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  height: 26,
                                  fontSize: 12,
                                  padding: '0 6px',
                                  borderRadius: 5,
                                  border: '1px solid var(--gb-border)',
                                  background: 'var(--gb-surface-elevated)',
                                  color: 'var(--gb-text)',
                                }}
                              />
                              <button
                                type="submit"
                                className="gb-row-action-btn"
                                aria-label="Save conversation title"
                                disabled={isBusy || !editTitle.trim()}
                              >
                                <Check size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="gb-row-action-btn"
                                aria-label="Cancel rename"
                                onClick={() => setEditingId(null)}
                              >
                                <X size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                              </button>
                            </form>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="gb-conv-select"
                                onClick={() => {
                                  onSelectSession(s.id)
                                  setPopoverOpen(false)
                                }}
                              >
                                <span className="gb-conv-title-row">
                                  <span className="gb-conv-title">{s.title}</span>
                                  {indicator && (
                                    <span className="gb-badge" style={{ fontSize: 10, padding: '1px 5px' }}>
                                      {indicator}
                                    </span>
                                  )}
                                </span>
                                {s.lastMessagePreview && (
                                  <span className="gb-conv-preview">{s.lastMessagePreview}</span>
                                )}
                              </button>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                {s.unread && onMarkSessionRead && (
                                  <button
                                    type="button"
                                    className="gb-row-action-btn"
                                    aria-label={`Mark ${s.title} read`}
                                    title="Mark read"
                                    disabled={isBusy}
                                    onClick={() => void onMarkSessionRead(s.id)}
                                  >
                                    <CheckCheck size={13} strokeWidth={ICON_STROKE} aria-hidden="true" />
                                  </button>
                                )}
                                {onRenameSession && (
                                  <button
                                    type="button"
                                    className="gb-row-action-btn"
                                    aria-label={`Rename ${s.title}`}
                                    title="Rename conversation"
                                    disabled={isBusy}
                                    onClick={() => {
                                      setEditingId(s.id)
                                      setEditTitle(s.title)
                                    }}
                                  >
                                    <Pencil size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                                  </button>
                                )}
                                {onArchiveSession && (
                                  <button
                                    type="button"
                                    className="gb-row-action-btn"
                                    aria-label={`Archive ${s.title}`}
                                    title={s.activeRunId ? 'Cannot archive while running' : 'Archive conversation'}
                                    disabled={isBusy || Boolean(s.activeRunId)}
                                    onClick={() => void onArchiveSession(s.id)}
                                  >
                                    <Archive size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                                  </button>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          {onNewChat && (
            <button
              type="button"
              onClick={onNewChat}
              title="New conversation"
              aria-label="New conversation"
              className="gb-btn-outline gb-icon-inline"
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              <SquarePen size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span className="gb-new-chat-label">New chat</span>
            </button>
          )}
          <IconButton
            label="Edit bot"
            title="Edit bot configuration"
            onClick={onEditBot}
          >
            <Ellipsis size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </>
      ) : (
        <>
          <strong className="gb-chat-header-title">No bot selected</strong>
          <div style={{ flex: 1 }} />
        </>
      )}
      <IconButton
        label={rightCollapsed ? 'Expand right workspace' : 'Collapse right workspace'}
        onClick={onToggleRight}
        active={!rightCollapsed}
        pressed={!rightCollapsed}
      >
        <PanelRight size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
    </header>
  )
}
