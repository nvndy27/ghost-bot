import { useEffect, useRef, useState } from 'react'
import type { PrivateTaskChatRecord, TeamDiscussionTurn, TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import { ListTodo } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE } from './IconButton.tsx'
import { TeamMemberRouting } from './TeamMemberRouting.tsx'

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
  const [rounds, setRounds] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
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

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    const loadTasks = async () => {
      try {
        const res = await bridge.listPrivateTaskChats({ teamId: team.id })
        if (!cancelled) setPrivateTasks(res.tasks)
      } catch {
        // ignore transient refresh failure
      }
    }
    void loadTasks()
    if (!hasActiveTasks) return () => { cancelled = true }
    const timer = window.setInterval(() => {
      void loadTasks()
    }, 150)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [bridge, team.id, hasActiveTasks])

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
    if (!bridge || beforeSeq === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await bridge.listTeamDiscussion({ teamId: team.id, beforeSeq })
      setTurns((previous) => [...result.turns, ...previous])
      setBeforeSeq(result.nextBeforeSeq)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load earlier messages')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="gb-messages">
        <div className="gb-messages-inner">
          <TeamMemberRouting team={team} bots={bots} />
          {privateTasks.length > 0 && (
            <section className="gb-card" aria-label="Delegated private tasks" style={{ display: 'grid', gap: 6 }}>
              <strong style={{ fontSize: 12.5 }}>Private Task Chats ({privateTasks.length})</strong>
              {privateTasks.map((task) => {
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
                        onClick={() => void bridge.cancelPrivateTaskChat({ teamId: team.id, teamRunId: task.teamRunId }).then(() => {
                          onTasksChanged?.()
                          return bridge.listPrivateTaskChats({ teamId: team.id }).then((r) => setPrivateTasks(r.tasks))
                        })}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )
              })}
            </section>
          )}
          {beforeSeq !== null && <button className="gb-btn-outline" disabled={busy} onClick={() => void loadEarlier()}>Load earlier messages</button>}
          {!available && <p className="gb-muted">Group replies are available in offline mock mode.</p>}
          {turns.map((turn) => (
            <section className="gb-card" key={turn.id}>
              <strong>You</strong>
              <p style={{ whiteSpace: 'pre-wrap' }}>{turn.text}</p>
              {turn.replies.map((reply, idx) => {
                const bot = bots.find((entry) => entry.id === reply.botId)
                return <div key={`${reply.botId}-${reply.round ?? 1}-${idx}`} style={{ marginTop: 8 }}>
                  <div className="gb-icon-inline" style={{ flexWrap: 'wrap', gap: 6 }}>
                    {bot && <BotAvatar config={bot.avatar} status="idle" size={24} />}
                    <strong>{bot?.name ?? reply.botId}</strong>
                    <span className="gb-badge">{reply.routing.modelId}</span>
                    {reply.round === 2 && <span className="gb-badge">Round 2</span>}
                  </div>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{reply.text}</p>
                </div>
              })}
            </section>
          ))}
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
      <form className="gb-composer-wrap" onSubmit={(event) => { event.preventDefault(); void send() }}>
        <div className="gb-composer">
          <textarea aria-label="Group discussion message" placeholder="Message the group" maxLength={4000}
            disabled={!available || busy} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="gb-composer-footer">
            <select aria-label="Insert member mention" value="" disabled={!available || busy}
              onChange={(event) => setDraft((previous) => `${previous.trimEnd()}${previous.trim() ? ' ' : ''}@${event.target.value} `.slice(0, 4000))}>
              <option value="" disabled>Mention</option>
              <option value="all">Everyone</option>
              {team.memberBotIds.map((id) => <option key={id} value={id}>{bots.find((bot) => bot.id === id)?.name ?? id}</option>)}
            </select>
            <select aria-label="Discussion rounds" value={String(rounds)} disabled={!available || busy}
              onChange={(event) => setRounds(event.target.value === '2' ? 2 : 1)}>
              <option value="1">1 round</option>
              <option value="2">2 rounds</option>
            </select>
            <button
              type="button"
              className="gb-btn-outline gb-icon-inline"
              disabled={!available}
              aria-pressed={delegateOpen}
              onClick={() => setDelegateOpen((v) => !v)}
            >
              <ListTodo size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} aria-hidden="true" />
              <span>Delegate task</span>
            </button>
            {busy ? (
              <button type="button" className="gb-btn-outline" onClick={() => void cancelDiscussion()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="gb-btn-accent" disabled={!available || !draft.trim()}>
                Send to group
              </button>
            )}
          </div>
        </div>
      </form>
    </>
  )
}
