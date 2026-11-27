import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import { PanelLeft, PanelRight, Pencil } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface TeamWorkspaceViewProps {
  team: TeamRecordDto
  bots: WorkspaceBot[]
  runs: Array<Record<string, unknown>>
  activeRun: Record<string, unknown> | null
  tasks: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  diagnostics: Record<string, unknown> | null
  planPreview: Record<string, unknown> | null
  planPreviewError: string | null
  runError: string | null
  isMockMode: boolean
  startingRun: boolean
  cancellingRun: boolean
  leftCollapsed: boolean
  rightCollapsed: boolean
  onSelectRun: (teamRunId: string) => void
  onPreviewPlan: (goal: string) => Promise<void>
  onStartRun: (goal: string) => Promise<void>
  onCancelRun: (teamRunId: string) => Promise<void>
  onResolveApproval: (runId: string, approvalId: string, decision: 'approved' | 'denied') => Promise<void>
  onEditTeam: () => void
  onToggleLeft: () => void
  onToggleRight: () => void
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function isRunActive(status: string): boolean {
  return (
    status === 'pending' ||
    status === 'queued' ||
    status === 'running' ||
    status === 'awaiting_approval' ||
    status === 'cancelling'
  )
}

export function TeamWorkspaceView({
  team,
  bots,
  runs,
  activeRun,
  tasks,
  approvals,
  messages,
  diagnostics,
  planPreview,
  planPreviewError,
  runError,
  isMockMode,
  startingRun,
  cancellingRun,
  leftCollapsed,
  rightCollapsed,
  onSelectRun,
  onPreviewPlan,
  onStartRun,
  onCancelRun,
  onResolveApproval,
  onEditTeam,
  onToggleLeft,
  onToggleRight,
}: TeamWorkspaceViewProps) {
  const [goalInput, setGoalInput] = useState('')
  const [showDagPanel, setShowDagPanel] = useState(true)
  const [resolvingIds, setResolvingIds] = useState<Record<string, boolean>>({})

  const botById = new Map(bots.map((b) => [b.id, b]))
  const leadBot = botById.get(team.leadBotId)
  const activeRunId = activeRun ? asString(activeRun.id) : ''
  const activeRunStatus = activeRun ? asString(activeRun.status, 'idle') : 'idle'
  const runIsActive = activeRunId.length > 0 && isRunActive(activeRunStatus)
  const hasUncertain =
    activeRunStatus === 'uncertain' ||
    tasks.some((t) => t.status === 'uncertain') ||
    (typeof diagnostics?.uncertainCount === 'number' && diagnostics.uncertainCount > 0)

  const handleSubmitGoal = async () => {
    const trimmed = goalInput.trim()
    if (!trimmed || startingRun) return
    await onStartRun(trimmed)
    setGoalInput('')
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmitGoal()
    }
  }

  const handleApproval = async (runId: string, approvalId: string, decision: 'approved' | 'denied') => {
    if (resolvingIds[approvalId]) return
    setResolvingIds((prev) => ({ ...prev, [approvalId]: true }))
    try {
      await onResolveApproval(runId, approvalId, decision)
    } finally {
      setResolvingIds((prev) => {
        const next = { ...prev }
        delete next[approvalId]
        return next
      })
    }
  }

  const previewLayers = Array.isArray(planPreview?.layers)
    ? (planPreview.layers as Array<Record<string, unknown>>)
    : []

  return (
    <>
      <header className="gb-chat-header">
        <div className="gb-chat-header-title">
          {leftCollapsed && (
            <IconButton label="Show sidebar" onClick={onToggleLeft} pressed={false}>
              <PanelLeft size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          )}
          {leadBot && <BotAvatar config={leadBot.avatar} status={runIsActive ? 'working' : 'idle'} size={28} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{team.name}</strong>
              <span className="gb-badge">Lead: {leadBot?.name ?? team.leadBotId}</span>
              <span className="gb-badge">
                {isMockMode ? 'Simulated (Mock)' : 'Live Teams Unavailable'}
              </span>
            </div>
            {team.description && (
              <div className="gb-muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {team.description}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {runs.length > 0 && (
            <select
              aria-label="Select team run"
              value={activeRunId}
              onChange={(e) => onSelectRun(e.target.value)}
              style={{
                borderRadius: 8,
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface)',
                color: 'var(--gb-text)',
                padding: '5px 8px',
                font: 'inherit',
                fontSize: 12,
                maxWidth: 210,
              }}
            >
              {runs.map((run) => {
                const id = asString(run.id)
                const status = asString(run.status, 'unknown')
                const goal = asString(run.goal, id)
                return (
                  <option key={id} value={id}>
                    [{status}] {goal.slice(0, 36)}
                  </option>
                )
              })}
            </select>
          )}

          <button type="button" className="gb-btn-outline gb-icon-inline" onClick={onEditTeam}>
            <Pencil size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
            <span>Edit team</span>
          </button>
          {rightCollapsed && (
            <IconButton label="Show team panel" onClick={onToggleRight} pressed={false}>
              <PanelRight size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </header>

      <div className="gb-messages" style={{ flex: 1, overflowY: 'auto' }}>
        <div className="gb-messages-inner" style={{ display: 'grid', gap: 12 }}>
          {runError && (
            <div
              role="alert"
              className="gb-card"
              style={{ borderColor: 'var(--gb-danger)', color: 'var(--gb-danger)', fontSize: 13 }}
            >
              {runError}
            </div>
          )}

          {(activeRunStatus === 'cancelling' || activeRunStatus === 'cancelled' || hasUncertain) && (
            <div
              role="status"
              className="gb-card"
              style={{
                borderColor: hasUncertain ? 'var(--gb-danger)' : 'var(--gb-border)',
                display: 'grid',
                gap: 4,
                fontSize: 13,
              }}
            >
              <strong>
                {hasUncertain
                  ? 'Execution outcome uncertain — manual review required'
                  : activeRunStatus === 'cancelling'
                    ? 'Cancellation pending — stopping active worker tasks...'
                    : 'Team run cancelled'}
              </strong>
              <span className="gb-muted" style={{ fontSize: 12 }}>
                {hasUncertain
                  ? 'One or more tasks ended in an uncertain state and will NOT be automatically replayed.'
                  : 'Reservations and partial task states are preserved in the ledger below.'}
              </span>
            </div>
          )}

          {approvals.length > 0 && (
            <section aria-label="Pending worker approvals" style={{ display: 'grid', gap: 8 }}>
              <div className="gb-section-label" style={{ margin: 0 }}>
                Pending Worker Approvals ({approvals.length})
              </div>
              {approvals.map((approval) => {
                const approvalId = asString(approval.approvalId ?? approval.id)
                const daemonRunId = asString(approval.daemonRunId ?? approval.runId)
                const botId = asString(approval.workerBotId ?? approval.botId)
                const botName = botById.get(botId)?.name ?? botId
                const title = asString(approval.title, 'Worker action approval')
                const command = asString(approval.command)
                const scope = asString(approval.permissionMode ?? approval.scope, 'single-action')
                const busy = Boolean(resolvingIds[approvalId])
                return (
                  <div key={approvalId} className="gb-card" style={{ display: 'grid', gap: 8 }}>
                    <div className="gb-approval-title" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <span>
                        Worker <strong>{botName}</strong> · {title}
                      </span>
                      <span className="gb-badge">{scope}</span>
                    </div>
                    {command && (
                      <div style={{ fontSize: 12 }}>
                        <code>{command}</code>
                      </div>
                    )}
                    <div className="gb-muted" style={{ fontSize: 11 }}>
                      Worker approvals are single-action only (no team-wide reusable grants).
                    </div>
                    <div className="gb-approval-actions">
                      <button
                        type="button"
                        className="gb-btn-accent"
                        disabled={busy || !daemonRunId || !approvalId}
                        onClick={() => void handleApproval(daemonRunId, approvalId, 'approved')}
                      >
                        {busy ? 'Submitting...' : 'Approve once'}
                      </button>
                      <button
                        type="button"
                        className="gb-btn-outline"
                        disabled={busy || !daemonRunId || !approvalId}
                        onClick={() => void handleApproval(daemonRunId, approvalId, 'denied')}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                )
              })}
            </section>
          )}

          <section className="gb-card" style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>DAG Plan Preview & Task Ledger</strong>
              <button
                type="button"
                className="gb-btn-outline"
                style={{ padding: '4px 8px', fontSize: 12 }}
                onClick={() => setShowDagPanel((prev) => !prev)}
              >
                {showDagPanel ? 'Collapse' : 'Expand'}
              </button>
            </div>

            {showDagPanel && (
              <div style={{ display: 'grid', gap: 10 }}>
                {planPreviewError && (
                  <div style={{ color: 'var(--gb-danger)', fontSize: 12 }}>{planPreviewError}</div>
                )}

                {planPreview && (
                  <div
                    style={{
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--gb-border)',
                      background: 'var(--gb-surface)',
                      display: 'grid',
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong>Plan Preview</strong>
                      <span className="gb-muted">
                        Est. tokens:{' '}
                        {typeof planPreview.estimatedTotalTokens === 'number'
                          ? planPreview.estimatedTotalTokens.toLocaleString()
                          : '—'}
                      </span>
                    </div>
                    {previewLayers.length > 0 ? (
                      previewLayers.map((layer, idx) => {
                        const layerTasks = Array.isArray(layer.tasks)
                          ? (layer.tasks as Array<Record<string, unknown>>)
                          : []
                        return (
                          <div key={idx} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                            <span className="gb-badge">Layer {idx + 1}</span>
                            {layerTasks.map((lt) => {
                              const pk = asString(lt.planKey, 'task')
                              const bid = asString(lt.assignedBotId)
                              const bname = botById.get(bid)?.name ?? bid
                              return (
                                <span key={pk} className="gb-badge">
                                  {pk} → {bname}
                                </span>
                              )
                            })}
                          </div>
                        )
                      })
                    ) : (
                      <div className="gb-muted">Plan validated ({tasks.length} tasks).</div>
                    )}
                  </div>
                )}

                {tasks.length === 0 ? (
                  <div className="gb-muted" style={{ fontSize: 12 }}>
                    No tasks yet. Preview a DAG plan or start a team run below.
                  </div>
                ) : (
                  <div className="gb-tool-list" style={{ display: 'grid', gap: 6 }}>
                    {tasks.map((task) => {
                      const taskId = asString(task.id)
                      const planKey = asString(task.planKey, taskId)
                      const assignedBotId = asString(task.assignedBotId)
                      const assignedName = botById.get(assignedBotId)?.name ?? assignedBotId
                      const status = asString(task.status, 'pending')
                      const depState = asString(task.dependencyState, 'ready')
                      const failureReason = asString(task.sanitizedFailureReason)
                      const tokensUsed = typeof task.tokensUsed === 'number' ? task.tokensUsed : null
                      return (
                        <div
                          key={taskId}
                          className="gb-tool-row"
                          style={{
                            display: 'grid',
                            gap: 4,
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--gb-border)',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12 }}>
                              <strong>{planKey}</strong> · {assignedName}
                            </span>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                              <span className="gb-badge">dep: {depState}</span>
                              <span className="gb-badge">{status}</span>
                              {tokensUsed !== null && <span className="gb-muted">{tokensUsed} tok</span>}
                            </div>
                          </div>
                          {failureReason && (
                            <div style={{ color: 'var(--gb-danger)', fontSize: 12 }}>{failureReason}</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <section aria-label="Team messages" style={{ display: 'grid', gap: 8 }}>
            <div className="gb-section-label" style={{ margin: 0 }}>
              Team Conversation ({messages.length})
            </div>
            {messages.length === 0 ? (
              <div className="gb-muted" style={{ fontSize: 13 }}>
                No team messages recorded for this run yet.
              </div>
            ) : (
              messages.map((msg, idx) => {
                const msgId = asString(msg.id, String(idx))
                const fromBotId = asString(msg.fromBotId)
                const senderRole = asString(msg.senderRole, 'worker')
                const senderName = fromBotId ? (botById.get(fromBotId)?.name ?? fromBotId) : senderRole
                const content = asString(msg.content, '')
                const isWorker = senderRole === 'worker' || (fromBotId !== '' && fromBotId !== team.leadBotId)
                return (
                  <div key={msgId} className="gb-card" style={{ display: 'grid', gap: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <strong style={{ fontSize: 12 }}>{senderName}</strong>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {isWorker && <span className="gb-badge">Untrusted worker output</span>}
                        <span className="gb-badge">{senderRole}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{content}</div>
                  </div>
                )
              })
            )}
          </section>
        </div>
      </div>

      <div className="gb-composer-wrap">
        <div className="gb-composer">
          <textarea
            rows={2}
            value={goalInput}
            onChange={(e) => setGoalInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Assign a goal to ${team.name} (Chief of Staff: ${leadBot?.name ?? team.leadBotId})...`}
            aria-label="Team goal input"
          />
          <div className="gb-composer-footer">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="gb-btn-outline"
                onClick={() => void onPreviewPlan(goalInput.trim() || `Coordinate ${team.name} task`)}
              >
                Preview DAG Plan
              </button>
              {runIsActive && (
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ borderColor: 'var(--gb-danger)', color: 'var(--gb-danger)' }}
                  disabled={cancellingRun}
                  onClick={() => void onCancelRun(activeRunId)}
                >
                  {cancellingRun ? 'Stopping...' : 'Stop Team Run'}
                </button>
              )}
            </div>
            <button
              type="button"
              className="gb-btn-accent"
              disabled={startingRun || goalInput.trim().length === 0}
              onClick={() => void handleSubmitGoal()}
              aria-label="Start team run"
            >
              {startingRun ? 'Starting...' : 'Start Team Run'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
