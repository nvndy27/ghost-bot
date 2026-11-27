import { useEffect, useRef, useState } from 'react'
import type { PrivateTaskChatRecord } from '@ghost-bot/shared-types/ipc'
import { ArrowLeft, PanelLeft, PanelRight, Square } from 'lucide-react'
import type { ChatMessage, WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'
import { MessageList } from './MessageList.tsx'

export interface PrivateTaskChatViewProps {
  task: PrivateTaskChatRecord
  bot: WorkspaceBot | null
  leftCollapsed: boolean
  rightCollapsed: boolean
  onBackToGroup: () => void
  onTaskUpdated: (task: PrivateTaskChatRecord) => void
  onToggleLeft: () => void
  onToggleRight: () => void
}

const ACTIVE_TASK_STATUSES = new Set(['pending', 'queued', 'running', 'awaiting_approval', 'cancelling'])

export function PrivateTaskChatView({
  task,
  bot,
  leftCollapsed,
  rightCollapsed,
  onBackToGroup,
  onTaskUpdated,
  onToggleLeft,
  onToggleRight,
}: PrivateTaskChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onTaskUpdatedRef = useRef(onTaskUpdated)
  onTaskUpdatedRef.current = onTaskUpdated
  const bridge = window.ghostBot

  const isActive = ACTIVE_TASK_STATUSES.has(task.status)
  const shouldPoll = isActive || messages.some((m) => m.role === 'assistant' && m.streaming)

  useEffect(() => {
    if (!bridge || !task.sessionId) return
    let cancelled = false

    const sync = async () => {
      try {
        const [msgRes, listRes] = await Promise.all([
          bridge.listMessages({ sessionId: task.sessionId!, limit: 200 }),
          bridge.listPrivateTaskChats({ teamId: task.teamId }),
        ])
        if (cancelled) return
        setMessages(
          msgRes.messages.map((m) =>
            m.role === 'user'
              ? {
                  id: m.id,
                  role: 'user',
                  text: m.text,
                  timestamp: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                }
              : {
                  id: m.id,
                  role: 'assistant',
                  text: m.text,
                  streaming: m.status === 'streaming',
                  timestamp: new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                },
          ),
        )
        const latest = listRes.tasks.find((t) => t.teamRunId === task.teamRunId)
        if (latest) {
          onTaskUpdatedRef.current(latest)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load task conversation')
        }
      }
    }

    void sync()
    if (!shouldPoll) return () => { cancelled = true }
    const timer = window.setInterval(() => {
      void sync()
    }, 150)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, task.sessionId, task.teamId, task.teamRunId, shouldPoll])

  const handleCancel = async () => {
    if (!bridge || cancelling || !isActive) return
    setCancelling(true)
    setError(null)
    try {
      await bridge.cancelPrivateTaskChat({ teamId: task.teamId, teamRunId: task.teamRunId })
      const listRes = await bridge.listPrivateTaskChats({ teamId: task.teamId })
      const latest = listRes.tasks.find((t) => t.teamRunId === task.teamRunId)
      if (latest) onTaskUpdated(latest)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel task')
    } finally {
      setCancelling(false)
    }
  }

  return (
    <>
      <header className="gb-chat-header" data-testid="private-task-header">
        {leftCollapsed && (
          <IconButton label="Expand left sidebar" onClick={onToggleLeft} pressed={!leftCollapsed}>
            <PanelLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        )}
        <IconButton label="Back to group" title="Back to group" onClick={onBackToGroup}>
          <ArrowLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </IconButton>
        {bot && <BotAvatar config={bot.avatar} status={isActive ? 'working' : 'idle'} size={30} />}
        <div style={{ minWidth: 0, display: 'grid' }}>
          <strong className="gb-chat-header-title">{bot?.name ?? task.assignedBotId}</strong>
          <span className="gb-muted" style={{ fontSize: 11.5 }}>
            Group Task · {task.teamName}
          </span>
        </div>
        <span className="gb-badge">{task.status}</span>
        {task.routing && <span className="gb-badge">{task.routing.modelId}</span>}
        <div style={{ flex: 1 }} />
        {isActive && (
          <button
            type="button"
            className="gb-btn-outline gb-icon-inline"
            style={{ fontSize: 12, padding: '4px 10px' }}
            disabled={cancelling}
            onClick={() => void handleCancel()}
          >
            <Square size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>{cancelling ? 'Stopping…' : 'Cancel task'}</span>
          </button>
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

      <div style={{ padding: '10px 24px 0' }}>
        <div className="gb-card" style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong>Task Objective</strong>
            <span className="gb-muted" style={{ fontSize: 11 }}>
              Session: {task.sessionId ?? 'pending'}
            </span>
          </div>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.objective}</p>
          {task.errorMessage && (
            <p role="alert" style={{ margin: 0, color: 'var(--gb-danger)', fontSize: 12 }}>
              {task.errorMessage}
            </p>
          )}
          {error && (
            <p role="alert" style={{ margin: 0, color: 'var(--gb-danger)', fontSize: 12 }}>
              {error}
            </p>
          )}
        </div>
      </div>

      {bot ? (
        <MessageList
          bot={bot}
          messages={messages}
          onResolveApproval={() => {}}
          onReviewDiff={() => {}}
          onUsePrompt={() => {}}
          isMockMode
        />
      ) : (
        <div className="gb-messages">
          <div className="gb-messages-inner">
            <p className="gb-muted">Assigned bot is unavailable.</p>
          </div>
        </div>
      )}
    </>
  )
}
