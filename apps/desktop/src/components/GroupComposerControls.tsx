import { useEffect, useId, useRef, useState } from 'react'
import { AtSign, ListTodo, Repeat2 } from 'lucide-react'
import type { WorkspaceBot } from '../types/workspace.ts'
import { BotAvatar } from './BotAvatar.tsx'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export function GroupComposerControls({ memberIds, bots, rounds, disabled, delegationOpen, onMention, onRounds, onDelegate }: {
  memberIds: string[]
  bots: WorkspaceBot[]
  rounds: 1 | 2
  disabled: boolean
  delegationOpen: boolean
  onMention: (id: string) => void
  onRounds: (rounds: 1 | 2) => void
  onDelegate: () => void
}) {
  const [panel, setPanel] = useState<'mention' | 'rounds' | null>(null)
  const [query, setQuery] = useState('')
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const mentionTrigger = useRef<HTMLButtonElement>(null)
  const roundsTrigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const filter = query.trim().replace(/^@/, '').toLowerCase()
  const members = memberIds.map((memberId) => {
    const bot = bots.find((entry) => entry.id === memberId)
    return { id: memberId, name: bot?.name ?? memberId, bot }
  })
  const choices = [{ id: 'all', name: 'Everyone', bot: undefined }, ...members]
    .filter((member) => member.id.toLowerCase().includes(filter) || member.name.toLowerCase().includes(filter))

  useEffect(() => {
    if (!panel || disabled) return
    if (panel === 'mention') search.current?.focus()
    else popup.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()

    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setPanel(null)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('focusin', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('focusin', dismiss)
    }
  }, [panel, disabled])

  function toggle(next: 'mention' | 'rounds') {
    setQuery('')
    setPanel(panel === next ? null : next)
  }

  const visiblePanel = disabled ? null : panel
  return (
    <div ref={root} className="gb-composer-selectors gb-group-composer-controls"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !visiblePanel) return
        event.preventDefault()
        event.stopPropagation()
        setPanel(null)
        if (visiblePanel === 'mention') mentionTrigger.current?.focus()
        else roundsTrigger.current?.focus()
      }}>
      <IconButton ref={mentionTrigger} label="Insert member mention" disabled={disabled}
        aria-expanded={visiblePanel === 'mention'} aria-controls={visiblePanel === 'mention' ? id : undefined}
        onClick={() => toggle('mention')}>
        <AtSign size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      <IconButton ref={roundsTrigger} label={`Discussion rounds, ${rounds} selected`} disabled={disabled}
        className="gb-rounds-control" aria-expanded={visiblePanel === 'rounds'}
        aria-controls={visiblePanel === 'rounds' ? id : undefined} onClick={() => toggle('rounds')}>
        <Repeat2 size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span aria-hidden="true">{rounds}</span>
      </IconButton>
      <IconButton label="Delegate task" disabled={disabled} pressed={delegationOpen}
        onClick={() => { setPanel(null); onDelegate() }}>
        <ListTodo size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>

      {visiblePanel === 'mention' && (
        <div id={id} ref={popup} className="gb-group-composer-popover" role="group" aria-label="Mention a member">
          <input ref={search} type="search" className="gb-search-input" aria-label="Search group members"
            placeholder="Search members" value={query} onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'ArrowDown' || event.key === 'Enter') {
                event.preventDefault()
                const first = popup.current?.querySelector('button')
                if (event.key === 'ArrowDown') first?.focus()
                else first?.click()
              }
            }} />
          <div className="gb-group-mention-results">
            {choices.map((member) => (
              <button type="button" key={member.id} title={member.name}
                onClick={() => { setPanel(null); onMention(member.id) }}>
                {member.bot && <BotAvatar config={member.bot.avatar} status="idle" size={20} />}
                <span>{member.name}</span><small className="gb-muted">@{member.id}</small>
              </button>
            ))}
            {choices.length === 0 && <p className="gb-muted" role="status">No matching members</p>}
          </div>
        </div>
      )}
      {visiblePanel === 'rounds' && (
        <div id={id} ref={popup} className="gb-group-composer-popover gb-group-rounds-popover"
          role="group" aria-label="Discussion rounds">
          {([1, 2] as const).map((value) => (
            <button type="button" key={value} aria-pressed={rounds === value}
              onClick={() => { onRounds(value); setPanel(null); roundsTrigger.current?.focus() }}>
              {value} {value === 1 ? 'round' : 'rounds'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
