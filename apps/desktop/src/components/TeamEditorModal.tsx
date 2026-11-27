import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { CreateTeamIpcInput, TeamRecordDto, UpdateTeamIpcInput } from '@ghost-bot/shared-types/ipc'
import { X } from 'lucide-react'
import { useModalDialog } from '../hooks/useModalDialog.ts'
import type { WorkspaceBot } from '../types/workspace.ts'
import { ICON_SIZE, ICON_STROKE, IconButton } from './IconButton.tsx'

export interface TeamEditorModalProps {
  open: boolean
  mode: 'create' | 'edit'
  initialTeam: TeamRecordDto | null
  bots: WorkspaceBot[]
  onSaveCreate: (input: CreateTeamIpcInput) => Promise<void>
  onSaveEdit: (input: UpdateTeamIpcInput) => Promise<void>
  onArchive?: (teamId: string) => Promise<void>
  onClose: () => void
}

const DEFAULT_BOUNDS = {
  maxDepth: 3,
  maxAttempts: 2,
  maxTokens: 12000,
  maxDurationMs: 120000,
  maxConcurrentTasks: 2,
  maxTasksPerRun: 12,
}

export function TeamEditorModal({
  open,
  mode,
  initialTeam,
  bots,
  onSaveCreate,
  onSaveEdit,
  onArchive,
  onClose,
}: TeamEditorModalProps) {
  const modalRef = useRef<HTMLDivElement | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [leadBotId, setLeadBotId] = useState('')
  const [memberBotIds, setMemberBotIds] = useState<string[]>([])
  const [maxDepth, setMaxDepth] = useState(DEFAULT_BOUNDS.maxDepth)
  const [maxAttempts, setMaxAttempts] = useState(DEFAULT_BOUNDS.maxAttempts)
  const [maxTokens, setMaxTokens] = useState(DEFAULT_BOUNDS.maxTokens)
  const [maxDurationMs, setMaxDurationMs] = useState(DEFAULT_BOUNDS.maxDurationMs)
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(DEFAULT_BOUNDS.maxConcurrentTasks)
  const [maxTasksPerRun, setMaxTasksPerRun] = useState(DEFAULT_BOUNDS.maxTasksPerRun)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setErrorMsg(null)
    setConfirmArchive(false)
    if (mode === 'edit' && initialTeam) {
      setName(initialTeam.name)
      setDescription(initialTeam.description ?? '')
      setLeadBotId(initialTeam.leadBotId)
      setMemberBotIds(initialTeam.memberBotIds)
      setMaxDepth(initialTeam.bounds.maxDepth ?? DEFAULT_BOUNDS.maxDepth)
      setMaxAttempts(initialTeam.bounds.maxAttempts ?? DEFAULT_BOUNDS.maxAttempts)
      setMaxTokens(initialTeam.bounds.maxTokens ?? DEFAULT_BOUNDS.maxTokens)
      setMaxDurationMs(initialTeam.bounds.maxDurationMs ?? DEFAULT_BOUNDS.maxDurationMs)
      setMaxConcurrentTasks(initialTeam.bounds.maxConcurrentTasks ?? DEFAULT_BOUNDS.maxConcurrentTasks)
      setMaxTasksPerRun(initialTeam.bounds.maxTasksPerRun ?? DEFAULT_BOUNDS.maxTasksPerRun)
    } else {
      const defaultLead = bots[0]?.id ?? ''
      const defaultMembers = bots.slice(0, Math.min(2, bots.length)).map((b) => b.id)
      setName('')
      setDescription('')
      setLeadBotId(defaultLead)
      setMemberBotIds(defaultMembers)
      setMaxDepth(DEFAULT_BOUNDS.maxDepth)
      setMaxAttempts(DEFAULT_BOUNDS.maxAttempts)
      setMaxTokens(DEFAULT_BOUNDS.maxTokens)
      setMaxDurationMs(DEFAULT_BOUNDS.maxDurationMs)
      setMaxConcurrentTasks(DEFAULT_BOUNDS.maxConcurrentTasks)
      setMaxTasksPerRun(DEFAULT_BOUNDS.maxTasksPerRun)
    }
  }, [open, mode, initialTeam, bots])

  useModalDialog(open, modalRef, onClose)

  if (!open) return null

  const toggleMember = (botId: string) => {
    if (botId === leadBotId) return
    setMemberBotIds((prev) =>
      prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId],
    )
  }

  const handleLeadChange = (nextLeadId: string) => {
    setLeadBotId(nextLeadId)
    setMemberBotIds((prev) => (prev.includes(nextLeadId) ? prev : [nextLeadId, ...prev]))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) {
      setErrorMsg('Team name is required.')
      return
    }
    if (!leadBotId) {
      setErrorMsg('Select a Chief of Staff bot.')
      return
    }
    const normalizedMembers = memberBotIds.includes(leadBotId)
      ? memberBotIds
      : [leadBotId, ...memberBotIds]
    if (normalizedMembers.length === 0) {
      setErrorMsg('Select at least one team member.')
      return
    }

    const bounds = {
      maxDepth: Math.max(1, Math.min(5, Math.trunc(maxDepth))),
      maxAttempts: Math.max(1, Math.min(5, Math.trunc(maxAttempts))),
      maxTokens: Math.max(100, Math.min(500_000, Math.trunc(maxTokens))),
      maxDurationMs: Math.max(1000, Math.min(3_600_000, Math.trunc(maxDurationMs))),
      maxConcurrentTasks: Math.max(1, Math.min(10, Math.trunc(maxConcurrentTasks))),
      maxTasksPerRun: Math.max(1, Math.min(100, Math.trunc(maxTasksPerRun))),
    }

    setSubmitting(true)
    setErrorMsg(null)
    try {
      if (mode === 'create') {
        await onSaveCreate({
          name: trimmedName,
          description: description.trim() || undefined,
          leadBotId,
          memberBotIds: normalizedMembers,
          bounds,
        })
      } else if (initialTeam) {
        await onSaveEdit({
          teamId: initialTeam.id,
          name: trimmedName,
          description: description.trim(),
          leadBotId,
          memberBotIds: normalizedMembers,
          bounds,
        })
      }
      onClose()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save team.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleArchive = async () => {
    if (!initialTeam || !onArchive) return
    setSubmitting(true)
    setErrorMsg(null)
    try {
      await onArchive(initialTeam.id)
      onClose()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to archive team.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="gb-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={modalRef}
        className="gb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-editor-title"
        style={{ width: 'min(620px, 94vw)', maxHeight: '88vh', overflow: 'auto' }}
      >
        <div className="gb-modal-head">
          <strong id="team-editor-title">
            {mode === 'create' ? 'Create Team' : `Edit Team · ${initialTeam?.name ?? ''}`}
          </strong>
          <IconButton label="Close team editor" onClick={onClose}>
            <X size={ICON_SIZE.md} strokeWidth={ICON_STROKE} aria-hidden="true" />
          </IconButton>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: 20, display: 'grid', gap: 14 }}>
          {errorMsg && (
            <div
              role="alert"
              style={{
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--gb-danger)',
                color: 'var(--gb-danger)',
                fontSize: 13,
              }}
            >
              {errorMsg}
            </div>
          )}

          <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <span>Team name</span>
            <input
              type="text"
              className="gb-search-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Research & Verification Squad"
              maxLength={120}
              required
            />
          </label>

          <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional team purpose and coordination scope"
              rows={2}
              maxLength={1000}
              style={{
                width: '100%',
                borderRadius: 8,
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface)',
                color: 'var(--gb-text)',
                padding: '8px 10px',
                font: 'inherit',
                resize: 'vertical',
              }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <span>Chief of Staff (Lead Bot)</span>
            <select
              value={leadBotId}
              onChange={(e) => handleLeadChange(e.target.value)}
              style={{
                borderRadius: 8,
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface)',
                color: 'var(--gb-text)',
                padding: '8px 10px',
                font: 'inherit',
              }}
            >
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name} ({bot.permission})
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <span>Team members ({memberBotIds.length} selected)</span>
            <div
              style={{
                display: 'grid',
                gap: 6,
                maxHeight: 150,
                overflow: 'auto',
                padding: 10,
                borderRadius: 8,
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface)',
              }}
            >
              {bots.map((bot) => {
                const isLead = bot.id === leadBotId
                const checked = isLead || memberBotIds.includes(bot.id)
                return (
                  <label
                    key={bot.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      cursor: isLead ? 'default' : 'pointer',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isLead}
                        onChange={() => toggleMember(bot.id)}
                      />
                      <span>{bot.name}</span>
                    </span>
                    <span className="gb-badge">{isLead ? 'Chief of Staff' : bot.permission}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <div className="gb-section-label" style={{ margin: 0 }}>
              Execution Bounds
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max depth (1-5)</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={1}
                  max={5}
                  value={maxDepth}
                  onChange={(e) => setMaxDepth(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max attempts (1-5)</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={1}
                  max={5}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max concurrent (1-10)</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={1}
                  max={10}
                  value={maxConcurrentTasks}
                  onChange={(e) => setMaxConcurrentTasks(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max tokens</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={100}
                  max={500000}
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max duration (ms)</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={1000}
                  max={3600000}
                  value={maxDurationMs}
                  onChange={(e) => setMaxDurationMs(Number(e.target.value))}
                />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span className="gb-muted">Max tasks / run</span>
                <input
                  type="number"
                  className="gb-search-input"
                  min={1}
                  max={100}
                  value={maxTasksPerRun}
                  onChange={(e) => setMaxTasksPerRun(Number(e.target.value))}
                />
              </label>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              paddingTop: 6,
            }}
          >
            <div>
              {mode === 'edit' && initialTeam && onArchive && (
                confirmArchive ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      type="button"
                      className="gb-btn-outline"
                      style={{ borderColor: 'var(--gb-danger)', color: 'var(--gb-danger)' }}
                      disabled={submitting}
                      onClick={() => void handleArchive()}
                    >
                      Confirm archive
                    </button>
                    <button
                      type="button"
                      className="gb-btn-outline"
                      disabled={submitting}
                      onClick={() => setConfirmArchive(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="gb-btn-outline"
                    disabled={submitting}
                    onClick={() => setConfirmArchive(true)}
                  >
                    Archive team
                  </button>
                )
              )}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="gb-btn-outline" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button type="submit" className="gb-btn-accent" disabled={submitting}>
                {submitting ? 'Saving...' : mode === 'create' ? 'Create Team' : 'Save Team'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
