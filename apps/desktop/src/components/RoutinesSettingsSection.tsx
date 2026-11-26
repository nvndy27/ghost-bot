import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type {
  RoutineNotificationDto,
  RoutineRecordDto,
  RoutineTaskDto,
  TeamRecordDto,
} from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

export interface RoutinesSettingsSectionProps {
  bots: WorkspaceBot[]
  teams: TeamRecordDto[]
  activeBotId: string | null
  isMockMode: boolean
  onRefreshWorkspaceRoutines?: () => void
  onNavigateToBot?: (botId: string) => void
  onNavigateToTeam?: (teamId: string) => void
}

type TriggerKind = 'one-time' | 'interval' | 'daily' | 'weekly' | 'cron'
type FilterMode = 'all' | 'enabled' | 'disabled' | 'archived'

export function RoutinesSettingsSection({
  bots,
  teams,
  activeBotId,
  isMockMode,
  onRefreshWorkspaceRoutines,
  onNavigateToBot,
  onNavigateToTeam,
}: RoutinesSettingsSectionProps) {
  const [routines, setRoutines] = useState<RoutineRecordDto[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // Editor state
  const [editorMode, setEditorMode] = useState<'closed' | 'create' | 'edit'>('closed')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [targetType, setTargetType] = useState<'bot' | 'team'>('bot')
  const [botId, setBotId] = useState(activeBotId ?? bots[0]?.id ?? '')
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [prompt, setPrompt] = useState('')
  const [triggerKind, setTriggerKind] = useState<TriggerKind>('daily')
  const [runAt, setRunAt] = useState('2026-12-01T09:00:00.000Z')
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [dailyHour, setDailyHour] = useState(9)
  const [dailyMinute, setDailyMinute] = useState(0)
  const [weeklyDays, setWeeklyDays] = useState('1,3,5')
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5')
  const [timezone, setTimezone] = useState('UTC')
  const [expiresAt, setExpiresAt] = useState('')
  const [missedRunPolicy, setMissedRunPolicy] = useState<'skip' | 'run-once' | 'bounded-catch-up'>('skip')
  const [concurrencyPolicy, setConcurrencyPolicy] = useState<'forbid' | 'allow-bounded'>('forbid')
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1)
  const [maxAttempts, setMaxAttempts] = useState(2)
  const [enabledOnCreate, setEnabledOnCreate] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)

  // Diagnostics / Preview / Simulation / History / Notifications / Import-Export
  const [previewResult, setPreviewResult] = useState<Record<string, unknown> | null>(null)
  const [diagResult, setDiagResult] = useState<Record<string, unknown> | null>(null)
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null)
  const [historyTasks, setHistoryTasks] = useState<RoutineTaskDto[]>([])
  const [inspectedTask, setInspectedTask] = useState<RoutineTaskDto | null>(null)
  const [notifications, setNotifications] = useState<RoutineNotificationDto[]>([])
  const [unreadCount, setUnreadCount] = useState(0)

  const [exportJson, setExportJson] = useState<string | null>(null)
  const [importText, setImportText] = useState('')
  const [importPolicy, setImportPolicy] = useState<'skip' | 'overwrite' | 'rename'>('skip')
  const [importPreview, setImportPreview] = useState<Record<string, unknown> | null>(null)

  const reqSeqRef = useRef(0)
  const detailsSeqRef = useRef(0)
  const onRefreshRef = useRef(onRefreshWorkspaceRoutines)
  onRefreshRef.current = onRefreshWorkspaceRoutines

  const selectedRoutine = routines.find((r) => r.id === selectedId) ?? null
  const scopeBotId = selectedRoutine?.botId ?? activeBotId ?? bots[0]?.id ?? ''

  const loadRoutines = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    const seq = ++reqSeqRef.current
    setLoading(true)
    try {
      const res = await bridge.listRoutines({ includeArchived: true })
      if (seq !== reqSeqRef.current) return
      const list = res.routines as RoutineRecordDto[]
      setRoutines(list)
      setErrorMsg(null)
      if (scopeBotId) {
        const [notifRes, countRes] = await Promise.all([
          bridge.listRoutineNotifications({ botId: scopeBotId, limit: 50 }),
          bridge.getRoutineUnreadNotificationCount({ botId: scopeBotId }),
        ])
        if (seq !== reqSeqRef.current) return
        setNotifications(notifRes.notifications as RoutineNotificationDto[])
        setUnreadCount(countRes.unreadCount)
      }
      onRefreshRef.current?.()
    } catch (err) {
      if (seq !== reqSeqRef.current) return
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load routines')
    } finally {
      if (seq === reqSeqRef.current) setLoading(false)
    }
  }, [scopeBotId])

  useEffect(() => {
    void loadRoutines()
  }, [loadRoutines])

  const loadRoutineDetails = useCallback(async (routine: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    const seq = ++detailsSeqRef.current
    try {
      const hist = await bridge.listRoutineHistory({
        routineId: routine.id,
        botId: routine.botId,
        count: 25,
      })
      if (seq !== detailsSeqRef.current) return
      setHistoryTasks(hist.tasks as RoutineTaskDto[])
    } catch (err) {
      if (seq !== detailsSeqRef.current) return
      setErrorMsg(err instanceof Error ? err.message : 'Failed to load routine history')
    }
  }, [])

  const handleSelectRoutine = (r: RoutineRecordDto) => {
    setSelectedId(r.id)
    setPreviewResult(null)
    setDiagResult(null)
    setSimResult(null)
    setInspectedTask(null)
    void loadRoutineDetails(r)
  }

  const openCreateEditor = () => {
    setEditorMode('create')
    setName('')
    setDescription('')
    setTargetType('bot')
    setBotId(activeBotId ?? bots[0]?.id ?? '')
    setTeamId(teams[0]?.id ?? '')
    setPrompt('')
    setTriggerKind('daily')
    setDailyHour(9)
    setDailyMinute(0)
    setCronExpr('0 9 * * 1-5')
    setTimezone('UTC')
    setExpiresAt('')
    setMissedRunPolicy('skip')
    setConcurrencyPolicy('forbid')
    setMaxConcurrentRuns(1)
    setMaxAttempts(2)
    setEnabledOnCreate(true)
    setErrorMsg(null)
  }

  const openEditEditor = (r: RoutineRecordDto) => {
    setEditorMode('edit')
    setName(r.name)
    setDescription(r.description)
    setTargetType(r.targetType ?? 'bot')
    setBotId(r.botId)
    setTeamId(r.teamId ?? teams[0]?.id ?? '')
    setPrompt(r.task.prompt)
    const kind = r.trigger.kind as TriggerKind
    setTriggerKind(kind === 'one-time' || kind === 'interval' || kind === 'daily' || kind === 'weekly' || kind === 'cron' ? kind : 'daily')
    if (kind === 'one-time' && typeof r.trigger.runAt === 'string') setRunAt(r.trigger.runAt)
    if (kind === 'interval' && typeof r.trigger.intervalMs === 'number') {
      setIntervalMinutes(Math.max(1, Math.round(r.trigger.intervalMs / 60_000)))
    }
    if (kind === 'daily') {
      setDailyHour(Number(r.trigger.hour ?? 9))
      setDailyMinute(Number(r.trigger.minute ?? 0))
    }
    if (kind === 'weekly') {
      const days = Array.isArray(r.trigger.daysOfWeek) ? r.trigger.daysOfWeek.join(',') : '1,3,5'
      setWeeklyDays(days)
      setDailyHour(Number(r.trigger.hour ?? 9))
      setDailyMinute(Number(r.trigger.minute ?? 0))
    }
    if (kind === 'cron' && typeof r.trigger.expression === 'string') {
      setCronExpr(r.trigger.expression)
    }
    setTimezone(r.timezone)
    setExpiresAt(r.expiresAt ?? '')
    setMissedRunPolicy(
      r.missedRunPolicy === 'run-once' || r.missedRunPolicy === 'bounded-catch-up'
        ? r.missedRunPolicy
        : 'skip',
    )
    setConcurrencyPolicy(r.concurrencyPolicy === 'allow-bounded' ? 'allow-bounded' : 'forbid')
    setMaxConcurrentRuns(r.maxConcurrentRuns)
    setMaxAttempts(r.retryPolicy.maxAttempts)
    setErrorMsg(null)
  }

  const buildTriggerPayload = () => {
    if (triggerKind === 'one-time') return { kind: 'one-time' as const, runAt: runAt.trim() }
    if (triggerKind === 'interval') {
      return {
        kind: 'interval' as const,
        intervalMs: Math.max(60_000, Math.trunc(intervalMinutes) * 60_000),
        anchorAt: new Date().toISOString(),
      }
    }
    if (triggerKind === 'daily') {
      return {
        kind: 'daily' as const,
        hour: Math.max(0, Math.min(23, Math.trunc(dailyHour))),
        minute: Math.max(0, Math.min(59, Math.trunc(dailyMinute))),
      }
    }
    if (triggerKind === 'weekly') {
      const days = weeklyDays
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
      return {
        kind: 'weekly' as const,
        daysOfWeek: days.length > 0 ? days : [1],
        hour: Math.max(0, Math.min(23, Math.trunc(dailyHour))),
        minute: Math.max(0, Math.min(59, Math.trunc(dailyMinute))),
      }
    }
    return { kind: 'cron' as const, expression: cronExpr.trim() }
  }

  const handleSaveRoutine = async (e: FormEvent) => {
    e.preventDefault()
    const bridge = window.ghostBot
    if (!bridge || submitting) return
    setSubmitting(true)
    setErrorMsg(null)
    setStatusMsg(null)
    try {
      const trigger = buildTriggerPayload()
      if (editorMode === 'create') {
        const created = (await bridge.createRoutine({
          name: name.trim(),
          description: description.trim(),
          botId,
          targetType,
          teamId: targetType === 'team' ? teamId : null,
          trigger,
          timezone: timezone.trim() || 'UTC',
          task: { prompt: prompt.trim(), idempotent: false },
          enabled: enabledOnCreate,
          missedRunPolicy,
          concurrencyPolicy,
          maxConcurrentRuns,
          retryPolicy: {
            maxAttempts: Math.max(1, Math.min(5, Math.trunc(maxAttempts))),
            backoffMs: 5_000,
            retryNonIdempotent: false,
          },
          expiresAt: expiresAt.trim() ? expiresAt.trim() : null,
        })) as RoutineRecordDto
        setSelectedId(created.id)
        setStatusMsg(`Created routine "${created.name}".`)
      } else if (editorMode === 'edit' && selectedRoutine) {
        const updated = (await bridge.updateRoutine({
          routineId: selectedRoutine.id,
          botId: selectedRoutine.botId,
          name: name.trim(),
          description: description.trim(),
          targetType,
          teamId: targetType === 'team' ? teamId : null,
          trigger,
          timezone: timezone.trim() || 'UTC',
          task: { prompt: prompt.trim(), idempotent: false },
          missedRunPolicy,
          concurrencyPolicy,
          maxConcurrentRuns,
          retryPolicy: {
            maxAttempts: Math.max(1, Math.min(5, Math.trunc(maxAttempts))),
            backoffMs: 5_000,
            retryNonIdempotent: false,
          },
          expiresAt: expiresAt.trim() ? expiresAt.trim() : null,
        })) as RoutineRecordDto
        setStatusMsg(`Updated routine "${updated.name}" (rev ${updated.revision}).`)
      }
      setEditorMode('closed')
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save routine')
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggleEnabled = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setErrorMsg(null)
    try {
      if (r.enabled) {
        await bridge.disableRoutine({ routineId: r.id, botId: r.botId })
      } else {
        await bridge.enableRoutine({ routineId: r.id, botId: r.botId })
      }
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to toggle routine')
    }
  }

  const handleArchive = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setErrorMsg(null)
    try {
      await bridge.archiveRoutine({ routineId: r.id, botId: r.botId })
      setConfirmArchiveId(null)
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to archive routine')
    }
  }

  const handleTriggerNow = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge || submitting) return
    setSubmitting(true)
    setErrorMsg(null)
    try {
      await bridge.triggerRoutine({
        routineId: r.id,
        botId: r.botId,
        idempotencyKey: `ui-manual-${r.id}-${Date.now()}`,
      })
      setStatusMsg(`Triggered manual run for "${r.name}".`)
      await loadRoutineDetails(r)
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to trigger routine')
    } finally {
      setSubmitting(false)
    }
  }

  const handlePreview = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setErrorMsg(null)
    try {
      const res = await bridge.previewRoutineSchedule({ routineId: r.id, botId: r.botId, count: 5 })
      setPreviewResult(res)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to preview schedule')
    }
  }

  const handleDiagnose = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setErrorMsg(null)
    try {
      const res = await bridge.diagnoseRoutine({ routineId: r.id, botId: r.botId })
      setDiagResult(res)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to diagnose routine')
    }
  }

  const handleSimulate = async (r: RoutineRecordDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setErrorMsg(null)
    try {
      const res = await bridge.simulateRoutine({ routineId: r.id, botId: r.botId, count: 5 })
      setSimResult(res)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to run simulation')
    }
  }

  const handleInspectTask = async (task: RoutineTaskDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      const full = (await bridge.getRoutineTask({
        taskId: task.id,
        botId: task.botId,
      })) as RoutineTaskDto
      setInspectedTask(full)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to inspect task')
    }
  }

  const handleCancelTask = async (task: RoutineTaskDto) => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      await bridge.cancelRoutineTask({ taskId: task.id, botId: task.botId })
      if (selectedRoutine) await loadRoutineDetails(selectedRoutine)
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to cancel task')
    }
  }

  const handleResolveTaskApproval = async (
    task: RoutineTaskDto,
    decision: 'approved' | 'denied',
  ) => {
    const bridge = window.ghostBot
    if (!bridge || !task.approvalLink) return
    try {
      await bridge.resolveApproval({
        runId: task.approvalLink.daemonRunId,
        approvalId: task.approvalLink.daemonApprovalId,
        decision,
      })
      await handleInspectTask(task)
      if (selectedRoutine) await loadRoutineDetails(selectedRoutine)
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to resolve approval')
    }
  }

  const handleExport = async () => {
    const bridge = window.ghostBot
    if (!bridge || !scopeBotId) return
    try {
      const bundle = await bridge.exportRoutines({ botId: scopeBotId })
      setExportJson(JSON.stringify(bundle, null, 2))
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to export routines')
    }
  }

  const handleImportPreview = async () => {
    const bridge = window.ghostBot
    if (!bridge || !scopeBotId) return
    setErrorMsg(null)
    try {
      const bundle = JSON.parse(importText) as Record<string, unknown>
      const preview = await bridge.previewRoutineImport({
        botId: scopeBotId,
        bundle,
        conflictPolicy: importPolicy,
      })
      setImportPreview(preview)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Invalid import JSON bundle')
    }
  }

  const handleImportCommit = async () => {
    const bridge = window.ghostBot
    if (!bridge || !scopeBotId) return
    setErrorMsg(null)
    try {
      const bundle = JSON.parse(importText) as Record<string, unknown>
      const res = await bridge.commitRoutineImport({
        botId: scopeBotId,
        bundle,
        conflictPolicy: importPolicy,
      })
      const count = Array.isArray(res.imported) ? res.imported.length : 0
      setStatusMsg(`Imported ${count} routine(s) (disabled by default).`)
      setImportPreview(null)
      setImportText('')
      await loadRoutines()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to import routines')
    }
  }

  const filteredRoutines = routines.filter((r) => {
    if (filterMode === 'enabled' && (!r.enabled || r.archivedAt !== null)) return false
    if (filterMode === 'disabled' && (r.enabled || r.archivedAt !== null)) return false
    if (filterMode === 'archived' && r.archivedAt === null) return false
    const q = searchQuery.trim().toLowerCase()
    if (!q) return true
    return r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
  })

  return (
    <div data-testid="routines-settings-section" style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>
            Routines{' '}
            <span className="gb-badge">
              {isMockMode ? 'Simulated (Mock)' : 'Live Autonomous Execution Disabled'}
            </span>
          </h2>
          <div className="gb-muted" style={{ fontSize: 12 }}>
            Daemon-managed schedules. Schedule eligibility does not grant autonomous live provider execution.
          </div>
        </div>
        <button type="button" className="gb-btn-accent" onClick={openCreateEditor}>
          + New routine
        </button>
      </div>

      {errorMsg && (
        <div
          role="alert"
          className="gb-card"
          style={{ borderColor: 'var(--gb-danger)', color: 'var(--gb-danger)', fontSize: 12 }}
        >
          {errorMsg}
        </div>
      )}
      {statusMsg && (
        <div role="status" className="gb-card" style={{ fontSize: 12 }}>
          {statusMsg}
        </div>
      )}

      {/* Search & Filter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="search"
          className="gb-search-input"
          aria-label="Search routines"
          placeholder="Search routines..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <select
          aria-label="Filter routines"
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value as FilterMode)}
          style={{
            borderRadius: 8,
            border: '1px solid var(--gb-border)',
            background: 'var(--gb-surface)',
            color: 'var(--gb-text)',
            padding: '6px 8px',
            font: 'inherit',
            fontSize: 12,
          }}
        >
          <option value="all">All</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      {/* Routine List */}
      <div style={{ display: 'grid', gap: 6 }}>
        {loading && routines.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12 }}>Loading routines...</div>
        ) : filteredRoutines.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12 }}>No routines match the current filter.</div>
        ) : (
          filteredRoutines.map((r) => {
            const isSelected = r.id === selectedId
            const isExpired = r.expiresAt !== null && Date.now() >= Date.parse(r.expiresAt)
            return (
              <div
                key={r.id}
                className="gb-card"
                style={{
                  display: 'grid',
                  gap: 6,
                  borderColor: isSelected ? 'var(--gb-accent)' : 'var(--gb-border)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => handleSelectRoutine(r)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <strong>{r.name}</strong>
                  </button>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <span className="gb-badge">{r.targetType ?? 'bot'}</span>
                    <span className="gb-badge">{r.ownership}</span>
                    <span className="gb-badge">
                      {r.archivedAt ? 'Archived' : r.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                    {isExpired && <span className="gb-badge">Expired</span>}
                    <span className="gb-badge">rev {r.revision}</span>
                  </div>
                </div>
                <div className="gb-muted" style={{ fontSize: 12 }}>
                  {r.timezone} · {String(r.trigger.kind)} · Next: {r.nextRunAt ?? '—'}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => handleSelectRoutine(r)}>
                    Inspect
                  </button>
                  <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => { handleSelectRoutine(r); openEditEditor(r) }}>
                    Edit
                  </button>
                  {r.archivedAt === null && (
                    <>
                      <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => void handleToggleEnabled(r)}>
                        {r.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} disabled={!r.enabled || submitting} onClick={() => void handleTriggerNow(r)}>
                        Run now
                      </button>
                      {confirmArchiveId === r.id ? (
                        <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px', color: 'var(--gb-danger)' }} onClick={() => void handleArchive(r)}>
                          Confirm archive
                        </button>
                      ) : (
                        <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setConfirmArchiveId(r.id)}>
                          Archive
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Routine Editor */}
      {editorMode !== 'closed' && (
        <form onSubmit={(e) => void handleSaveRoutine(e)} className="gb-card" style={{ display: 'grid', gap: 10 }}>
          <strong>{editorMode === 'create' ? 'Create Routine' : 'Edit Routine'}</strong>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Routine name</span>
            <input type="text" className="gb-search-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Description</span>
            <input type="text" className="gb-search-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Target type</span>
              <select value={targetType} onChange={(e) => setTargetType(e.target.value as 'bot' | 'team')} className="gb-search-input">
                <option value="bot">Individual Bot</option>
                <option value="team">Multi-Agent Team</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>{targetType === 'team' ? 'Lead / Scope Bot' : 'Target Bot'}</span>
              <select value={botId} onChange={(e) => setBotId(e.target.value)} className="gb-search-input">
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
          </div>
          {targetType === 'team' && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Target Team</span>
              <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="gb-search-input">
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
          )}
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Task instructions (untrusted prompt data)</span>
            <textarea rows={2} className="gb-search-input" value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Schedule type</span>
              <select value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as TriggerKind)} className="gb-search-input">
                <option value="one-time">One-time</option>
                <option value="interval">Fixed interval</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="cron">Five-field cron</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>IANA Timezone</span>
              <input type="text" className="gb-search-input" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC or America/New_York" />
            </label>
          </div>
          <div className="gb-muted" style={{ fontSize: 11 }}>
            External event triggers (email/webhook) are unavailable in this offline build.
          </div>
          {triggerKind === 'one-time' && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Run at (ISO UTC)</span>
              <input type="text" className="gb-search-input" value={runAt} onChange={(e) => setRunAt(e.target.value)} />
            </label>
          )}
          {triggerKind === 'interval' && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Interval (minutes, min 1)</span>
              <input type="number" min={1} className="gb-search-input" value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
            </label>
          )}
          {(triggerKind === 'daily' || triggerKind === 'weekly') && (
            <div style={{ display: 'grid', gridTemplateColumns: triggerKind === 'weekly' ? '1fr 1fr 1fr' : '1fr 1fr', gap: 8 }}>
              {triggerKind === 'weekly' && (
                <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                  <span>Days (0=Sun..6=Sat)</span>
                  <input type="text" className="gb-search-input" value={weeklyDays} onChange={(e) => setWeeklyDays(e.target.value)} />
                </label>
              )}
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span>Hour (0-23)</span>
                <input type="number" min={0} max={23} className="gb-search-input" value={dailyHour} onChange={(e) => setDailyHour(Number(e.target.value))} />
              </label>
              <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
                <span>Minute (0-59)</span>
                <input type="number" min={0} max={59} className="gb-search-input" value={dailyMinute} onChange={(e) => setDailyMinute(Number(e.target.value))} />
              </label>
            </div>
          )}
          {triggerKind === 'cron' && (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Cron expression (5 fields)</span>
              <input type="text" className="gb-search-input" value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} />
            </label>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Missed-run policy</span>
              <select value={missedRunPolicy} onChange={(e) => setMissedRunPolicy(e.target.value as 'skip' | 'run-once' | 'bounded-catch-up')} className="gb-search-input">
                <option value="skip">skip</option>
                <option value="run-once">run-once</option>
                <option value="bounded-catch-up">bounded-catch-up</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Concurrency</span>
              <select value={concurrencyPolicy} onChange={(e) => setConcurrencyPolicy(e.target.value as 'forbid' | 'allow-bounded')} className="gb-search-input">
                <option value="forbid">forbid</option>
                <option value="allow-bounded">allow-bounded</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span>Max attempts (1-5)</span>
              <input type="number" min={1} max={5} className="gb-search-input" value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} />
            </label>
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span>Expiration ISO timestamp (optional)</span>
            <input type="text" className="gb-search-input" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} placeholder="2027-01-01T00:00:00.000Z" />
          </label>
          {editorMode === 'create' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input type="checkbox" checked={enabledOnCreate} onChange={(e) => setEnabledOnCreate(e.target.checked)} />
              <span>Enable routine immediately</span>
            </label>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="gb-btn-outline" onClick={() => setEditorMode('closed')}>Cancel</button>
            <button type="submit" className="gb-btn-accent" disabled={submitting}>
              {submitting ? 'Saving...' : 'Save routine'}
            </button>
          </div>
        </form>
      )}

      {/* Selected Routine Details: Preview, Diagnostics, Simulator, History */}
      {selectedRoutine && (
        <div className="gb-card" style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <strong>{selectedRoutine.name} · Diagnostics & History</strong>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => void handlePreview(selectedRoutine)}>
                Preview Schedule
              </button>
              <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => void handleDiagnose(selectedRoutine)}>
                Diagnose
              </button>
              <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => void handleSimulate(selectedRoutine)}>
                Simulate (Dry Run)
              </button>
              {selectedRoutine.targetType === 'team' && selectedRoutine.teamId && onNavigateToTeam && (
                <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => onNavigateToTeam(selectedRoutine.teamId!)}>
                  Open Team
                </button>
              )}
              {onNavigateToBot && (
                <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => onNavigateToBot(selectedRoutine.botId)}>
                  Open Bot
                </button>
              )}
            </div>
          </div>

          {previewResult && (
            <div style={{ fontSize: 12, padding: 8, borderRadius: 8, border: '1px solid var(--gb-border)' }}>
              <strong>Upcoming Occurrences ({String(previewResult.timezone)})</strong>
              {(previewResult.occurrences as Array<{ scheduledAtUtc: string; localDateTime: string }>).map((occ) => (
                <div key={occ.scheduledAtUtc} className="gb-muted">
                  Local: {occ.localDateTime} · UTC: {occ.scheduledAtUtc}
                </div>
              ))}
            </div>
          )}

          {diagResult && (
            <div style={{ fontSize: 12, padding: 8, borderRadius: 8, border: '1px solid var(--gb-border)' }}>
              <strong>Diagnostics</strong> · Active tasks: {String(diagResult.activeTaskCount)} · Uncertain: {String(diagResult.uncertainTaskCount)} · Reasons: {Array.isArray(diagResult.reasonCodes) && diagResult.reasonCodes.length > 0 ? diagResult.reasonCodes.join(', ') : 'none'}
            </div>
          )}

          {simResult && (
            <div style={{ fontSize: 12, padding: 8, borderRadius: 8, border: '1px solid var(--gb-border)' }}>
              <strong>Dry-Run Simulation (Simulated Only · No Tasks Enqueued)</strong> · Expected occurrences: {String(simResult.expectedOccurrences)} · Ticks: {String(simResult.ticksExecuted)}
            </div>
          )}

          <div style={{ display: 'grid', gap: 4 }}>
            <strong style={{ fontSize: 12 }}>Execution History ({historyTasks.length})</strong>
            {historyTasks.length === 0 ? (
              <div className="gb-muted" style={{ fontSize: 12 }}>No task history yet.</div>
            ) : (
              historyTasks.map((t) => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--gb-border)' }}>
                  <span>
                    {t.scheduledFor} · rev {t.routineRevision} · <strong>{t.status}</strong>
                    {t.uncertainExecution && ' · UNCERTAIN'}
                  </span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => void handleInspectTask(t)}>
                      Details
                    </button>
                    {(t.status === 'queued' || t.status === 'running' || t.status === 'awaiting_approval') && (
                      <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => void handleCancelTask(t)}>
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {inspectedTask && (
            <div className="gb-card" style={{ fontSize: 12, display: 'grid', gap: 4 }}>
              <strong>Task {inspectedTask.id}</strong>
              <div>Status: {inspectedTask.status} · Trigger: {inspectedTask.triggerSource} · Attempt {inspectedTask.attempt}/{inspectedTask.maxAttempts}</div>
              {inspectedTask.errorMessage && <div style={{ color: 'var(--gb-danger)' }}>{inspectedTask.errorCode}: {inspectedTask.errorMessage}</div>}
              {inspectedTask.executionLink && (
                <div className="gb-muted">
                  Linked run: {inspectedTask.executionLink.daemonRunId ?? inspectedTask.executionLink.teamRunId ?? 'none'}
                </div>
              )}
              {inspectedTask.approvalLink && inspectedTask.status === 'awaiting_approval' && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span>Approval {inspectedTask.approvalLink.daemonApprovalId} ({inspectedTask.approvalLink.state})</span>
                  <button type="button" className="gb-btn-accent" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => void handleResolveTaskApproval(inspectedTask, 'approved')}>
                    Approve once
                  </button>
                  <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => void handleResolveTaskApproval(inspectedTask, 'denied')}>
                    Deny
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Notifications */}
      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>Routine Notifications (Unread: {unreadCount})</strong>
          <span className="gb-muted" style={{ fontSize: 11 }}>
            Dismissal does not approve, deny, or cancel tasks.
          </span>
        </div>
        {notifications.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: 12 }}>No routine notifications.</div>
        ) : (
          notifications.slice(0, 10).map((n) => (
            <div key={n.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--gb-border)' }}>
              <span>
                <span className="gb-badge">{n.severity}</span> {n.summary}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {!n.readAt && (
                  <button
                    type="button"
                    className="gb-btn-outline"
                    style={{ fontSize: 11, padding: '2px 6px' }}
                    onClick={() => void window.ghostBot?.markRoutineNotificationRead({ notificationId: n.id, botId: n.botId }).then(() => loadRoutines())}
                  >
                    Mark read
                  </button>
                )}
                <button
                  type="button"
                  className="gb-btn-outline"
                  style={{ fontSize: 11, padding: '2px 6px' }}
                  onClick={() => void window.ghostBot?.dismissRoutineNotification({ notificationId: n.id, botId: n.botId }).then(() => loadRoutines())}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Import / Export */}
      <div className="gb-card" style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong style={{ fontSize: 13 }}>Import & Export</strong>
          <button type="button" className="gb-btn-outline" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => void handleExport()}>
            Export routines JSON
          </button>
        </div>
        <div className="gb-muted" style={{ fontSize: 11 }}>
          Warning: exported routine task instructions may contain sensitive workflow details. Imported routines remain disabled by default.
        </div>
        {exportJson && (
          <textarea
            aria-label="Exported routines JSON"
            rows={4}
            readOnly
            className="gb-search-input"
            value={exportJson}
          />
        )}
        <textarea
          aria-label="Import routines JSON"
          rows={3}
          className="gb-search-input"
          placeholder="Paste ghost-bot.scheduler.routines.v1 JSON bundle..."
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            aria-label="Import conflict policy"
            value={importPolicy}
            onChange={(e) => setImportPolicy(e.target.value as 'skip' | 'overwrite' | 'rename')}
            className="gb-search-input"
            style={{ width: 140 }}
          >
            <option value="skip">skip</option>
            <option value="overwrite">overwrite</option>
            <option value="rename">rename</option>
          </select>
          <button type="button" className="gb-btn-outline" style={{ fontSize: 12 }} disabled={!importText.trim()} onClick={() => void handleImportPreview()}>
            Preview import
          </button>
          {importPreview && Boolean(importPreview.valid) && (
            <button type="button" className="gb-btn-accent" style={{ fontSize: 12 }} onClick={() => void handleImportCommit()}>
              Confirm import
            </button>
          )}
        </div>
        {importPreview && (
          <div style={{ fontSize: 12 }}>
            Valid: {String(importPreview.valid)} · Would create: {String(importPreview.wouldCreate)} · Would rename: {String(importPreview.wouldRename)} · Conflicts: {Array.isArray(importPreview.conflicts) ? importPreview.conflicts.length : 0}
          </div>
        )}
      </div>
    </div>
  )
}
