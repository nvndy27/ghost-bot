import { useEffect, useRef, useState } from 'react'
import type { TeamDiscussionTurn, TeamRecordDto } from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { TeamMemberRouting } from './TeamMemberRouting.tsx'

export function TeamDiscussionView({ team, bots, isMockMode }: {
  team: TeamRecordDto
  bots: WorkspaceBot[]
  isMockMode: boolean
}) {
  const [turns, setTurns] = useState<TeamDiscussionTurn[]>([])
  const [beforeSeq, setBeforeSeq] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [rounds, setRounds] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef<{ text: string; operationId: string } | null>(null)
  const bridge = window.ghostBot
  const available = Boolean(bridge && isMockMode)

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
