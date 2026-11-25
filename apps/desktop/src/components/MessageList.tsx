import type {
  ChatMessage,
  PendingApproval,
  ToolStep,
  WorkspaceBot,
} from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'

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
            >
              {step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : '✳'}
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
  return (
    <div className="gb-card" role="region" aria-label="Approval request">
      <div className="gb-approval-title">
        <span aria-hidden="true">🛡</span>
        <span>{approval.title}</span>
      </div>
      <div>{approval.description}</div>
      {approval.decision === 'pending' ? (
        <div className="gb-approval-actions">
          <button
            type="button"
            className="gb-btn-outline"
            onClick={() => onReviewDiff(approval)}
          >
            Review diff
          </button>
          <button
            type="button"
            className="gb-btn-outline"
            onClick={() => onResolve(approval.id, 'denied')}
          >
            Deny
          </button>
          <button
            type="button"
            className="gb-btn-accent"
            onClick={() => onResolve(approval.id, 'approved')}
          >
            Approve
          </button>
        </div>
      ) : (
        <div style={{ marginTop: '8px' }}>
          <span className="gb-badge">
            {approval.decision === 'approved' ? 'Approved (mock)' : 'Denied (mock)'}
          </span>
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
              <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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
