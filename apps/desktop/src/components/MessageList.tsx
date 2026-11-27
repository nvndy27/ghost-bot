import { AlertCircle, Check, Loader2, ShieldCheck } from 'lucide-react'
import type {
  ChatMessage,
  PendingApproval,
  ToolStep,
  WorkspaceBot,
} from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE } from './IconButton.tsx'

export function UserMessage({ text }: { text: string }) {
  return <div className="gb-user-bubble">{text}</div>
}

export function StreamingMessage({ text }: { text: string }) {
  return (
    <div className="gb-assistant-prose" aria-live="polite">
      {text}
      <span className="gb-streaming-cursor" aria-hidden="true" />
    </div>
  )
}

export function AssistantMessage({ text }: { text: string }) {
  return <div className="gb-assistant-prose">{text}</div>
}

export function ToolActivityCard({ tools }: { tools: ToolStep[] }) {
  return (
    <div className="gb-card" role="region" aria-label="Tool activity">
      <div className="gb-tool-list">
        {tools.map((step) => (
          <div key={step.id} className="gb-tool-row">
            <span
              className={
                step.status === 'done' ? 'gb-tool-dot-done' : 'gb-tool-dot-running'
              }
              aria-hidden="true"
              style={{ display: 'inline-flex', alignItems: 'center' }}
            >
              {step.status === 'done' ? (
                <Check size={ICON_SIZE.xs} strokeWidth={2.2} />
              ) : step.status === 'failed' ? (
                <AlertCircle size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} style={{ color: 'var(--gb-danger)' }} />
              ) : (
                <Loader2 size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} className="gb-spin" />
              )}
            </span>
            <span>{step.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ApprovalCard({
  approval,
  onReviewDiff,
  onResolve,
}: {
  approval: PendingApproval
  onReviewDiff: (approval: PendingApproval) => void
  onResolve: (approvalId: string, decision: 'approved' | 'denied') => void
}) {
  const isResolving = approval.decision === 'resolving'
  const isPending = approval.decision === 'pending' || isResolving
  const scopeLabel = approval.isMock === false ? 'live' : 'mock'

  const statusText = (() => {
    switch (approval.decision) {
      case 'approved':
        return `Approved once (${scopeLabel})`
      case 'denied':
        return `Denied (${scopeLabel})`
      case 'expired':
        return `Expired (${scopeLabel})`
      case 'revoked':
        return `Revoked (${scopeLabel})`
      case 'resolution_failed':
        return `Delivery failed (${scopeLabel})`
      default:
        return ''
    }
  })()

  return (
    <div className="gb-card" role="region" aria-label="Approval request">
      <div className="gb-approval-title">
        <ShieldCheck size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" style={{ color: 'var(--gb-accent)' }} />
        <span>{approval.title}</span>
        {approval.permissionMode && (
          <span className="gb-badge" style={{ marginLeft: 'auto', fontSize: '11px' }}>
            {approval.permissionMode}
          </span>
        )}
      </div>
      {approval.actionType && (
        <div className="gb-muted" style={{ fontSize: '12px', marginBottom: '4px' }}>
          Action: <code>{approval.actionType}</code>
        </div>
      )}
      <div>{approval.description}</div>
      {isPending ? (
        <div className="gb-approval-actions">
          <button
            type="button"
            className="gb-btn-outline"
            disabled={isResolving}
            onClick={() => onReviewDiff(approval)}
          >
            Review diff
          </button>
          <button
            type="button"
            className="gb-btn-outline"
            disabled={isResolving}
            onClick={() => onResolve(approval.id, 'denied')}
          >
            {isResolving ? 'Resolving...' : 'Deny'}
          </button>
          <button
            type="button"
            className="gb-btn-accent"
            disabled={isResolving}
            onClick={() => onResolve(approval.id, 'approved')}
          >
            {isResolving ? 'Resolving...' : 'Approve once'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: '8px' }}>
          <span className="gb-badge">{statusText}</span>
        </div>
      )}
    </div>
  )
}

export function EmptyConversation({
  bot,
  isMockMode,
  onUsePrompt,
}: {
  bot: WorkspaceBot
  isMockMode: boolean
  onUsePrompt: (text: string) => void
}) {
  const prompts = [
    'Summarize workspace status',
    'Inspect pending tasks',
    'Simulate an approval request',
  ]
  return (
    <div
      style={{
        margin: 'auto',
        textAlign: 'center',
        maxWidth: '420px',
        padding: '32px 16px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
        <BotAvatar config={bot.avatar} status={bot.avatarStatus} size={56} />
      </div>
      <h2 style={{ margin: '0 0 6px', fontSize: '18px' }}>{bot.name}</h2>
      <p className="gb-muted" style={{ margin: '0 0 16px', fontSize: '13.5px' }}>
        {bot.instructions}
      </p>
      {isMockMode && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>
          {prompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="gb-btn-outline"
              onClick={() => onUsePrompt(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export interface MessageListProps {
  bot: WorkspaceBot
  messages: ChatMessage[]
  isMockMode: boolean
  onReviewDiff: (approval: PendingApproval) => void
  onResolveApproval: (approvalId: string, decision: 'approved' | 'denied') => void
  onUsePrompt: (text: string) => void
}

export function MessageList({
  bot,
  messages,
  isMockMode,
  onReviewDiff,
  onResolveApproval,
  onUsePrompt,
}: MessageListProps) {
  return (
    <div className="gb-messages" role="log" aria-label={`${bot.name} conversation`}>
      {messages.length === 0 ? (
        <EmptyConversation bot={bot} isMockMode={isMockMode} onUsePrompt={onUsePrompt} />
      ) : (
        <div className="gb-messages-inner">
          <div className="gb-timestamp">{messages[0]?.timestamp ?? 'Today'}</div>
          {messages.map((msg) => {
            if (msg.role === 'user') {
              return <UserMessage key={msg.id} text={msg.text} />
            }
            return (
              <div key={msg.id} className="gb-assistant-message" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div className="gb-message-author">
                  <BotAvatar config={bot.avatar} status={msg.streaming ? bot.avatarStatus : 'idle'} size={24} />
                  <strong>{bot.name}</strong>
                </div>
                {msg.streaming ? (
                  <StreamingMessage text={msg.text} />
                ) : (
                  <AssistantMessage text={msg.text} />
                )}
                {msg.tools && msg.tools.length > 0 && <ToolActivityCard tools={msg.tools} />}
                {msg.approval && (
                  <ApprovalCard
                    approval={msg.approval}
                    onReviewDiff={onReviewDiff}
                    onResolve={onResolveApproval}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
