import { useEffect, useRef, useState } from 'react'
import type { PrivateTaskChatRecord, TeamDiscussionTurn, TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import { ArrowUpRight } from 'lucide-react'
import { useComposerTextareaHeight } from '../hooks/useComposerTextareaHeight.ts'
import { ComposerSendButton } from './ComposerSendButton.tsx'
import { GroupComposerControls } from './GroupComposerControls.tsx'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE } from './IconButton.tsx'

const ACTIVE_TASK_STATUSES = new Set(['pending', 'queued', 'running', 'awaiting_approval', 'cancelling'])

export function TeamDiscussionView({
  team,
  bots,
  isMockMode,
  onOpenPrivateTask,
  onTasksChanged,
}: {
  team: TeamRecordDto
  bots: WorkspaceBot[]
  isMockMode: boolean
  onOpenPrivateTask?: (task: PrivateTaskChatRecord) => void
  onTasksChanged?: () => void
}) {
  const [turns, setTurns] = useState<TeamDiscussionTurn[]>([])
  const [beforeSeq, setBeforeSeq] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const textareaRef = useComposerTextareaHeight(draft)
  const [rounds, setRounds] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [delegateOpen, setDelegateOpen] = useState(false)
  const [delegateBotId, setDelegateBotId] = useState<string>(team.memberBotIds[0] ?? team.leadBotId)
  const [delegateObjective, setDelegateObjective] = useState('')
  const [delegating, setDelegating] = useState(false)
  const [privateTasks, setPrivateTasks] = useState<PrivateTaskChatRecord[]>([])
  const requestRef = useRef<{ text: string; operationId: string } | null>(null)
  const delegateOpRef = useRef<{ key: string; operationId: string } | null>(null)
  const bridge = window.ghostBot
  const available = Boolean(bridge && isMockMode)

  useEffect(() => {
    setDelegateBotId((cur) => (team.memberBotIds.includes(cur) ? cur : (team.memberBotIds[0] ?? team.leadBotId)))
  }, [team.id, team.leadBotId, team.memberBotIds])

  useEffect(() => {
    if (!bridge) return
    let active = true
    void bridge.listTeamDiscussion({ teamId: team.id }).then((result) => {
      if (!active) return
      setTurns((previous) => {
        const known = new Set(result.turns.map((turn) => turn.id))
        return [...result.turns, ...previous.filter((turn) => !known.has(turn.id))]
      })
      setBeforeSeq(result.nextBeforeSeq)
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Group discussion history unavailable')
    })
    return () => { active = false }
  }, [bridge, team.id])

  const hasActiveTasks = privateTasks.some((t) => ACTIVE_TASK_STATUSES.has(t.status))
  const missingSummary = privateTasks.some(
    (t) =>
      !ACTIVE_TASK_STATUSES.has(t.status) &&
      !turns.some((turn) => turn.taskSummary?.teamRunId === t.teamRunId),
  )
  const shouldPollTasks = hasActiveTasks || missingSummary

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const loadTasks = async () => {
      try {
        const res = await bridge.listPrivateTaskChats({ teamId: team.id })
        const disc = await bridge.listTeamDiscussion({ teamId: team.id })
        if (!cancelled) {
          setPrivateTasks(res.tasks)
          setTurns((previous) => {
            const byId = new Map(previous.map((t) => [t.id, t]))
            for (const t of disc.turns) byId.set(t.id, t)
            return [...byId.values()].sort((a, b) => a.seq - b.seq)
          })
        }
      } catch {
        // ignore transient refresh failure
      }
    }
    void loadTasks()
    if (!shouldPollTasks) {
      return () => { cancelled = true }
    }
    const timer = window.setInterval(() => {
      void loadTasks()
    }, 150)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, team.id, shouldPollTasks])

  async function send() {
    const text = draft.trim()
    if (!bridge || !available || !text || busy) return
    const request = requestRef.current?.text === text ? requestRef.current : { text, operationId: crypto.randomUUID() }
    requestRef.current = request
    setBusy(true)
    setStatusLabel(rounds === 2 ? 'Discussing (2 rounds)…' : 'Discussing…')
    setError(null)
    try {
      const turn = await bridge.sendTeamDiscussion({ teamId: team.id, rounds, ...request })
      setTurns((previous) => previous.some((entry) => entry.id === turn.id) ? previous : [...previous, turn])
      setDraft('')
      requestRef.current = null
      setStatusLabel(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send group message')
      setStatusLabel(null)
    } finally {
      setBusy(false)
    }
  }

  async function confirmDelegation() {
    const objective = delegateObjective.trim()
    if (!bridge || !available || !objective || delegating) return
    const opKey = `${delegateBotId}:${objective}`
    const op = delegateOpRef.current?.key === opKey
      ? delegateOpRef.current
      : { key: opKey, operationId: crypto.randomUUID() }
    delegateOpRef.current = op
    setDelegating(true)
    setError(null)
    try {
      const created = await bridge.delegateTeamTask({
        teamId: team.id,
        assignedBotId: delegateBotId,
        objective,
        operationId: op.operationId,
      })
      setPrivateTasks((prev) => [created, ...prev.filter((t) => t.teamRunId !== created.teamRunId)])
      setDelegateObjective('')
      setDelegateOpen(false)
      delegateOpRef.current = null
      onTasksChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delegate task')
    } finally {
      setDelegating(false)
    }
  }

  async function cancelDiscussion() {
    if (!bridge || !busy) return
    const operationId = requestRef.current?.operationId
    setStatusLabel('Stopping…')
    try {
      await bridge.cancelTeamDiscussion({ teamId: team.id, operationId })
    } catch {
      // Best-effort cancel; send() will settle.
    }
  }

  async function loadEarlier() {
    if (!bridge || beforeSeq === null || busy || loadingEarlier) return
    setLoadingEarlier(true)
    setError(null)
    try {
      const result = await bridge.listTeamDiscussion({ teamId: team.id, beforeSeq })
      setTurns((previous) => [...result.turns, ...previous])
      setBeforeSeq(result.nextBeforeSeq)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load earlier messages')
    } finally {
      setLoadingEarlier(false)
    }
  }

  return (
    <>
      <div className="gb-messages">
        <div className="gb-messages-inner">
          {privateTasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'uncertain') && (
            <section className="gb-task-strip" aria-label="Delegated private tasks">
              <strong style={{ fontSize: 12.5 }}>Private task activity</strong>
              {privateTasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'uncertain').map((task) => {
                const bot = bots.find((b) => b.id === task.assignedBotId)
                const active = ACTIVE_TASK_STATUSES.has(task.status)
                return (
                  <div
                    key={task.teamRunId}
                    data-private-task-id={task.teamRunId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      fontSize: 12,
                      padding: '4px 0',
                      borderTop: '1px solid var(--gb-border)',
                    }}
                  >
                    <div className="gb-icon-inline" style={{ minWidth: 0, gap: 6, flex: 1 }}>
                      {bot && <BotAvatar config={bot.avatar} status={active ? 'working' : 'idle'} size={20} />}
                      <span style={{ fontWeight: 500 }}>{bot?.name ?? task.assignedBotId}</span>
                      <span className="gb-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {task.objective}
                      </span>
                    </div>
                    <span className="gb-badge">{task.status}</span>
                    {onOpenPrivateTask && (
                      <button
                        type="button"
                        className="gb-btn-outline"
                        style={{ fontSize: 11.5, padding: '2px 8px' }}
                        onClick={() => onOpenPrivateTask(task)}
                      >
                        Open task chat
                      </button>
                    )}
                    {active && bridge && (
                      <button
                        type="button"
                        className="gb-btn-outline"
                        style={{ fontSize: 11.5, padding: '2px 8px' }}
                        onClick={() => void bridge.cancelPrivateTaskChat({ teamId: team.id, teamRunId: task.teamRunId, taskId: task.taskId }).then(() => {
                          onTasksChanged?.()
                          return bridge.listPrivateTaskChats({ teamId: team.id }).then((r) => setPrivateTasks(r.tasks))
                        }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not cancel task'))}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )
              })}
            </section>
          )}
          {beforeSeq !== null && <button className="gb-btn-outline" disabled={busy || loadingEarlier} onClick={() => void loadEarlier()}>Load earlier messages</button>}
          {!available && <p className="gb-muted">Group replies are available in offline mock mode.</p>}
          {turns.map((turn) => {
            const summary = turn.taskSummary
            if (summary) {
              const bot = bots.find((entry) => entry.id === summary.assignedBotId)
              const linkedTask = privateTasks.find((t) => t.teamRunId === summary.teamRunId)
              return (
                <section className="gb-discussion-reply gb-discussion-summary" key={turn.id}
                  data-task-summary={summary.teamRunId}>
                  {bot && <BotAvatar config={bot.avatar} status="idle" size={24} />}
                  <div className="gb-discussion-content">
                    <div className="gb-discussion-author">
                      <strong>{bot?.name ?? summary.assignedBotId}</strong>
                      <small className="gb-muted">Task Summary</small>
                    </div>
                    <div className="gb-discussion-bubble gb-task-summary-bubble">
                      <div className="gb-task-summary-heading">
                        <strong>{summary.objective}</strong>
                        <small className="gb-muted">{summary.status.replaceAll('_', ' ')}</small>
                      </div>
                      {turn.replies.map((reply, idx) => <p key={`${reply.botId}-${idx}`}>{reply.text}</p>)}
                      {summary.blocker && <p className="gb-task-summary-blocker">Blocker: {summary.blocker}</p>}
                      {onOpenPrivateTask && linkedTask && (
                        <button type="button" className="gb-task-summary-link" onClick={() => onOpenPrivateTask(linkedTask)}>
                          View task chat <ArrowUpRight size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              )
            }
            return (
              <section className="gb-discussion-turn" key={turn.id}>
                <p className="gb-discussion-bubble gb-discussion-user" aria-label="Your message">{turn.text}</p>
                {turn.replies.map((reply, idx) => {
                  const bot = bots.find((entry) => entry.id === reply.botId)
                  return <div className="gb-discussion-reply" key={`${reply.botId}-${reply.round ?? 1}-${idx}`}>
                    {bot && <BotAvatar config={bot.avatar} status="idle" size={24} />}
                    <div className="gb-discussion-content">
                      <div className="gb-discussion-author">
                        <strong>{bot?.name ?? reply.botId}</strong>
                        <small className="gb-muted">{reply.routing.modelId}{reply.round === 2 ? ' · Round 2' : ''}</small>
                      </div>
                      <p className="gb-discussion-bubble">{reply.text}</p>
                    </div>
                  </div>
                })}
              </section>
            )
          })}
          {statusLabel && <p className="gb-muted" role="status">{statusLabel}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
      </div>
      {delegateOpen && (
        <div style={{ padding: '0 24px 8px' }}>
          <div className="gb-card" role="region" aria-label="Delegate private task" style={{ display: 'grid', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 12.5 }}>Delegate Private Task Chat</strong>
              <button
                type="button"
                className="gb-btn-outline"
                style={{ fontSize: 11.5, padding: '2px 8px' }}
                onClick={() => setDelegateOpen(false)}
              >
                Close
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                aria-label="Delegate member"
                value={delegateBotId}
                disabled={delegating}
                onChange={(e) => setDelegateBotId(e.target.value)}
              >
                {team.memberBotIds.map((id) => (
                  <option key={id} value={id}>
                    {bots.find((b) => b.id === id)?.name ?? id}
                  </option>
                ))}
              </select>
              <input
                type="text"
                aria-label="Task objective"
                placeholder="Bounded task objective..."
                value={delegateObjective}
                maxLength={2000}
                disabled={delegating}
                onChange={(e) => setDelegateObjective(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: 200,
                  height: 30,
                  padding: '0 8px',
                  borderRadius: 6,
                  border: '1px solid var(--gb-border)',
                  background: 'var(--gb-surface-elevated)',
                  color: 'var(--gb-text)',
                }}
              />
              <button
                type="button"
                className="gb-btn-accent"
                aria-label="Confirm task delegation"
                disabled={!available || delegating || !delegateObjective.trim()}
                onClick={() => void confirmDelegation()}
              >
                {delegating ? 'Delegating…' : 'Confirm delegation'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="gb-composer-wrap">
        <form className="gb-composer gb-group-composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <textarea ref={textareaRef} rows={1} aria-label="Group discussion message" placeholder="Message the group"
            maxLength={4000} disabled={!available || busy} value={draft} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }} />
          <div className="gb-composer-footer">
            <GroupComposerControls memberIds={team.memberBotIds} bots={bots} rounds={rounds}
              disabled={!available || busy} delegationOpen={delegateOpen} onRounds={setRounds}
              onDelegate={() => setDelegateOpen(!delegateOpen)}
              onMention={(memberId) => {
                setDraft((previous) => {
                  const text = previous.trimEnd()
                  const next = `${text}${text ? ' ' : ''}@${memberId} `
                  return next.length <= 4000 ? next : previous
                })
                textareaRef.current?.focus()
              }} />
            <ComposerSendButton canSend={available && !busy && Boolean(draft.trim())} stopping={busy}
              onStop={() => void cancelDiscussion()} sendLabel="Send to group" stopLabel="Stop"
              disabledTitle={available ? 'Enter a group message' : 'Group replies require offline mock mode'} />
          </div>
        </form>
      </div>
    </>
  )
}
