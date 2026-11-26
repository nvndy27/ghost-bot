import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import { AppSettingsSchema } from '@ghost-bot/shared-types/ipc'
import type {
  AppSettings,
  AppSettingsPatch,
  BotRecord,
  CreateBotInput,
  CreateTeamIpcInput,
  DaemonHealthResponse,
  GhostBotBridge,
  PersistedMessage,
  ProviderSummary,
  RunRecord,
  RuntimeSnapshot,
  SessionInspectionResponse,
  SessionRecord,
  TeamRecordDto,
  UpdateBotInput,
  UpdateTeamIpcInput,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
import { BotEditorModal } from './components/BotEditorModal.tsx'
import { ChatComposer } from './components/ChatComposer.tsx'
import { ChatHeader } from './components/ChatHeader.tsx'
import { DiffPreviewModal } from './components/DiffPreviewModal.tsx'
import { LeftSidebar } from './components/LeftSidebar.tsx'
import { MessageList } from './components/MessageList.tsx'
import { RightPanel } from './components/RightPanel.tsx'
import { SettingsModal } from './components/SettingsModal.tsx'
import { TeamEditorModal } from './components/TeamEditorModal.tsx'
import { TeamRightPanel } from './components/TeamRightPanel.tsx'
import { TeamWorkspaceView } from './components/TeamWorkspaceView.tsx'
import { INITIAL_MOCK_BOTS, INITIAL_MOCK_MESSAGES } from './data/mockWorkspace.ts'
import {
  loadUiPreferences,
  resolveEffectiveTheme,
  saveUiPreferences,
} from './state/preferences.ts'
import type {
  ChatMessage,
  PendingApproval,
  UiPreferences,
  WorkspaceBot,
} from './types/workspace.ts'

declare global {
  interface Window {
    ghostBot?: GhostBotBridge
  }
}

const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({})

function recordToWorkspaceBot(rec: BotRecord): WorkspaceBot {
  return {
    id: rec.id,
    name: rec.name,
    description: rec.description,
    runtimeId: rec.runtimeId,
    statusLabel: 'Ready',
    avatarStatus: 'idle',
    avatar: rec.avatar,
    instructions: rec.instructions,
    workspacePath: rec.workspacePath,
    modelId: rec.modelId,
    effort: rec.effort,
    permission: rec.permission,
  }
}

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'cancelled',
  'failed',
  'interrupted',
])

function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Just now'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function persistedToChatMessage(msg: PersistedMessage, activeRun?: RunRecord | null): ChatMessage {
  const timestamp = formatMessageTime(msg.createdAt)
  if (msg.role === 'user') {
    return {
      id: msg.id,
      role: 'user',
      text: msg.text,
      timestamp,
    }
  }
  const isThisRun = Boolean(activeRun && msg.runId === activeRun.id)
  const pendingApproval = isThisRun ? activeRun?.pendingApproval : null
  const displayText =
    msg.status === 'interrupted' && !msg.text.includes('[Interrupted')
      ? `${msg.text}${msg.text ? '\n\n' : ''}[Interrupted — daemon restarted]`
      : msg.text

  return {
    id: msg.id,
    role: 'assistant',
    text: displayText,
    streaming: msg.status === 'streaming',
    timestamp,
    approval: pendingApproval
      ? {
          id: pendingApproval.approvalId,
          title: pendingApproval.title,
          description: pendingApproval.command,
          diffTitle: 'Simulated action preview',
          diffText: pendingApproval.command,
          decision: 'pending',
        }
      : undefined,
  }
}

export function App() {
  const hasBridge = typeof window !== 'undefined' && Boolean(window.ghostBot)
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (hasBridge) return DEFAULT_APP_SETTINGS
    return {
      ...DEFAULT_APP_SETTINGS,
      appearance: loadUiPreferences(),
    }
  })
  const [bots, setBots] = useState<WorkspaceBot[]>(() => (hasBridge ? [] : INITIAL_MOCK_BOTS))
  const [activeBotId, setActiveBotId] = useState<string | null>(() =>
    hasBridge ? null : 'chief',
  )
  const [botsLoaded, setBotsLoaded] = useState<boolean>(() => !hasBridge)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [messagesByBot, setMessagesByBot] = useState<Record<string, ChatMessage[]>>(
    () => (hasBridge ? {} : INITIAL_MOCK_MESSAGES),
  )
  const [sessionsByBot, setSessionsByBot] = useState<Record<string, SessionRecord[]>>({})
  const [activeSessionByBot, setActiveSessionByBot] = useState<Record<string, string | null>>({})
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({})
  const [activeRunBySession, setActiveRunBySession] = useState<Record<string, RunRecord | null>>({})
  const [inspectionBySession, setInspectionBySession] = useState<
    Record<string, SessionInspectionResponse | null>
  >({})
  const [draft, setDraft] = useState<string>('')
  const [streamingBotId, setStreamingBotId] = useState<string | null>(null)
  const [diffApproval, setDiffApproval] = useState<PendingApproval | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false)
  const [botEditor, setBotEditor] = useState<{ open: boolean; mode: 'create' | 'edit' }>({
    open: false,
    mode: 'create',
  })
  const [bannerError, setBannerError] = useState<string | null>(null)
  const [health, setHealth] = useState<DaemonHealthResponse | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<RuntimeSnapshot | null>(null)

  const streamTimerRef = useRef<number | null>(null)
  const runPollTimersRef = useRef<Map<string, number>>(new Map())
  const runSeqCursorRef = useRef<Map<string, number>>(new Map())

  const prefs: UiPreferences = settings.appearance
  const isMockMode = health === null || health.runtimeMode === 'mock'
  const activeBot = bots.find((b) => b.id === activeBotId) ?? bots[0] ?? null
  const [teams, setTeams] = useState<TeamRecordDto[]>([])
  const [teamsLoaded, setTeamsLoaded] = useState(false)
  const [teamsError, setTeamsError] = useState<string | null>(null)
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null)
  const [teamEditor, setTeamEditor] = useState<{ open: boolean; mode: 'create' | 'edit' }>({
    open: false,
    mode: 'create',
  })
  const [teamRuns, setTeamRuns] = useState<Array<Record<string, unknown>>>([])
  const [activeTeamRunId, setActiveTeamRunId] = useState<string | null>(null)
  const [activeTeamRun, setActiveTeamRun] = useState<Record<string, unknown> | null>(null)
  const [teamTasks, setTeamTasks] = useState<Array<Record<string, unknown>>>([])
  const [teamApprovals, setTeamApprovals] = useState<Array<Record<string, unknown>>>([])
  const [teamMessages, setTeamMessages] = useState<Array<Record<string, unknown>>>([])
  const [teamDiagnostics, setTeamDiagnostics] = useState<Record<string, unknown> | null>(null)
  const [teamAggregateUsage, setTeamAggregateUsage] = useState<Record<string, unknown> | null>(null)
  const [teamPlanPreview, setTeamPlanPreview] = useState<Record<string, unknown> | null>(null)
  const [teamPlanPreviewError, setTeamPlanPreviewError] = useState<string | null>(null)
  const [teamRunError, setTeamRunError] = useState<string | null>(null)
  const [startingTeamRun, setStartingTeamRun] = useState(false)
  const [cancellingTeamRun, setCancellingTeamRun] = useState(false)
  const teamRequestSeqRef = useRef(0)
  const activeTeam = teams.find((t) => t.id === activeTeamId) ?? null
  const activeBotSessions = activeBot ? (sessionsByBot[activeBot.id] ?? []) : []
  const activeSessionId = activeBot ? (activeSessionByBot[activeBot.id] ?? null) : null
  const activeSessionRun = activeSessionId ? (activeRunBySession[activeSessionId] ?? null) : null
  const activeSessionInspection = activeSessionId
    ? (inspectionBySession[activeSessionId] ?? null)
    : null
  const activeSessionIsStreaming = Boolean(
    activeSessionRun && !TERMINAL_RUN_STATUSES.has(activeSessionRun.status),
  )
  const activeMessages = hasBridge
    ? (activeSessionId ? (messagesBySession[activeSessionId] ?? []) : [])
    : (activeBot ? (messagesByBot[activeBot.id] ?? []) : [])

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveEffectiveTheme(prefs.theme)
      document.documentElement.dataset.reducedMotion = String(prefs.reducedMotion)
    }
    apply()
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    if (!media) return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [prefs.theme, prefs.reducedMotion])

  useEffect(() => {
    const bridge = window.ghostBot
    if (!bridge) return

    const legacy = loadUiPreferences()
    void Promise.all([
      bridge.getDaemonHealth(),
      bridge.listProviders(),
      bridge.listBots(),
      bridge.migrateLocalSettings(legacy),
      bridge.getRuntimeSnapshot(false),
    ])
      .then(([daemonHealth, providerList, botsRes, loadedSettings, snap]) => {
        setHealth(daemonHealth)
        setProviders(providerList)
        setBots(botsRes.bots.map(recordToWorkspaceBot))
        setSettings(loadedSettings)
        setRuntimeSnapshot(snap)
        setActiveBotId(
          loadedSettings.general.launchBehavior === 'restore'
            ? (botsRes.activeBotId ?? botsRes.bots[0]?.id ?? null)
            : (botsRes.bots[0]?.id ?? null),
        )
        setBotsLoaded(true)
        bridge
          .listTeams()
          .then((res) => {
            setTeams(res.teams)
            setTeamsError(null)
            setTeamsLoaded(true)
          })
          .catch((err: unknown) => {
            setTeamsError(err instanceof Error ? err.message : 'Failed to load teams')
            setTeamsLoaded(true)
          })
      })
      .catch((err: unknown) => {
        setBannerError(err instanceof Error ? err.message : 'Failed to load workspace state')
        setBotsLoaded(true)
        setTeamsLoaded(true)
      })
  }, [])

  useEffect(() => {
    return () => {
      if (streamTimerRef.current !== null) {
        window.clearInterval(streamTimerRef.current)
      }
      for (const timer of runPollTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      runPollTimersRef.current.clear()
      runSeqCursorRef.current.clear()
    }
  }, [])

  const stopPollingRun = (runId: string) => {
    const existing = runPollTimersRef.current.get(runId)
    if (existing !== undefined) {
      window.clearTimeout(existing)
      runPollTimersRef.current.delete(runId)
    }
    runSeqCursorRef.current.delete(`active:${runId}`)
  }

  const refreshSessionMessages = async (sessionId: string, runOverride?: RunRecord | null) => {
    const bridge = window.ghostBot
    if (!bridge) return
    const res = await bridge.listMessages({ sessionId, limit: 200 })
    const currentRun = runOverride ?? activeRunBySession[sessionId] ?? null
    setMessagesBySession((prev) => ({
      ...prev,
      [sessionId]: res.messages.map((m) => persistedToChatMessage(m, currentRun)),
    }))
  }

  const startPollingRun = (
    botId: string,
    sessionId: string,
    run: RunRecord,
    assistantMessageId?: string,
  ) => {
    const bridge = window.ghostBot
    if (!bridge) return
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      stopPollingRun(run.id)
      return
    }
    const activeKey = `active:${run.id}`
    if (runSeqCursorRef.current.has(activeKey)) return
    runSeqCursorRef.current.set(activeKey, 1)

    const scheduleNext = (delayMs: number) => {
      if (!runSeqCursorRef.current.has(activeKey)) return
      const timer = window.setTimeout(() => {
        void pollOnce()
      }, delayMs)
      runPollTimersRef.current.set(run.id, timer)
    }

    const pollOnce = async () => {
      if (!runSeqCursorRef.current.has(activeKey)) return
      try {
        const collectedEvents: Awaited<ReturnType<typeof bridge.getRunEvents>>['events'] = []
        let afterSeq = runSeqCursorRef.current.get(run.id) ?? 0
        let hasMore = true
        let pages = 0
        while (hasMore && pages < 5) {
          const page = await bridge.getRunEvents({ runId: run.id, afterSeq, limit: 200 })
          if (page.events.length > 0) {
            collectedEvents.push(...page.events)
            afterSeq = page.lastSeq
          }
          hasMore = page.hasMore
          pages += 1
        }
        const latestRun = await bridge.getRun(run.id)
        if (!runSeqCursorRef.current.has(activeKey)) return

        if (collectedEvents.length > 0) {
          runSeqCursorRef.current.set(run.id, afterSeq)
          setMessagesBySession((prev) => {
            const list = prev[sessionId] ?? []
            const targetIdx = assistantMessageId
              ? list.findIndex((m) => m.id === assistantMessageId)
              : list.map((m) => m.role).lastIndexOf('assistant')
            if (targetIdx < 0) return prev
            const target = list[targetIdx]
            if (!target || target.role !== 'assistant') return prev

            let nextText = target.text
            let nextTools = target.tools ? [...target.tools] : []
            let nextApproval = target.approval

            for (const evt of collectedEvents) {
              if (evt.type === 'message.delta' && typeof evt.payload.delta === 'string') {
                nextText += evt.payload.delta
              } else if (evt.type === 'tool.started') {
                const toolId = String(evt.payload.toolCallId ?? `tool-${evt.seq}`)
                const label = String(evt.payload.toolName ?? 'Simulated tool')
                if (!nextTools.some((t) => t.id === toolId)) {
                  nextTools.push({ id: toolId, label, status: 'running' })
                }
              } else if (evt.type === 'tool.completed') {
                const toolId = String(evt.payload.toolCallId ?? '')
                nextTools = nextTools.map((t) =>
                  t.id === toolId ? { ...t, status: 'done' as const } : t,
                )
              } else if (evt.type === 'approval.requested') {
                const appId = String(evt.payload.approvalId ?? 'approval')
                const title = String(evt.payload.title ?? 'Approval required')
                const cmd = String(evt.payload.command ?? '')
                const blockedReadOnly = Boolean(evt.payload.blockedInReadOnly)
                const isMockApp = evt.payload.isMock !== false
                nextApproval = {
                  id: appId,
                  title,
                  description: cmd,
                  diffTitle: blockedReadOnly
                    ? 'Blocked in read-only mode'
                    : isMockApp
                      ? 'Simulated action preview'
                      : 'Live action preview',
                  diffText: cmd,
                  actionType:
                    typeof evt.payload.tool === 'string'
                      ? evt.payload.tool
                      : typeof evt.payload.actionType === 'string'
                        ? evt.payload.actionType
                        : undefined,
                  argsHash: typeof evt.payload.argsHash === 'string' ? evt.payload.argsHash : undefined,
                  permissionMode:
                    typeof evt.payload.permissionMode === 'string'
                      ? evt.payload.permissionMode
                      : undefined,
                  expiresAt:
                    typeof evt.payload.expiresAt === 'string' ? evt.payload.expiresAt : undefined,
                  isMock: isMockApp,
                  decision: blockedReadOnly ? 'denied' : 'pending',
                }
              } else if (evt.type === 'approval.denied' && nextApproval) {
                nextApproval = { ...nextApproval, decision: 'denied' }
              } else if (evt.type === 'approval.expired' && nextApproval) {
                nextApproval = { ...nextApproval, decision: 'expired' }
              } else if (evt.type === 'approval.revoked' && nextApproval) {
                nextApproval = { ...nextApproval, decision: 'revoked' }
              } else if (evt.type === 'approval.resolution_failed' && nextApproval) {
                nextApproval = { ...nextApproval, decision: 'resolution_failed' }
              } else if (evt.type === 'approval.resolved' && nextApproval) {
                const decision = evt.payload.decision === 'approved' ? 'approved' : 'denied'
                nextApproval = { ...nextApproval, decision }
              }
            }

            const updated = [...list]
            updated[targetIdx] = {
              ...target,
              text: nextText,
              tools: nextTools.length > 0 ? nextTools : undefined,
              approval: nextApproval,
              streaming: !TERMINAL_RUN_STATUSES.has(latestRun.status),
            }
            return { ...prev, [sessionId]: updated }
          })
        }

        setActiveRunBySession((prev) => ({ ...prev, [sessionId]: latestRun }))
        setBots((prev) =>
          prev.map((b) => {
            if (b.id !== botId) return b
            if (latestRun.status === 'awaiting_approval') {
              return { ...b, statusLabel: 'Approval needed', avatarStatus: 'approval' }
            }
            if (TERMINAL_RUN_STATUSES.has(latestRun.status)) {
              return {
                ...b,
                statusLabel: latestRun.status === 'failed' ? 'Error' : 'Ready',
                avatarStatus: latestRun.status === 'completed' ? 'completed' : 'idle',
              }
            }
            return { ...b, statusLabel: 'Thinking...', avatarStatus: 'thinking' }
          }),
        )

        if (TERMINAL_RUN_STATUSES.has(latestRun.status)) {
          stopPollingRun(run.id)
          await refreshSessionMessages(sessionId, latestRun)
          const [sessRes, insp] = await Promise.all([
            bridge.listSessions({ agentId: botId }),
            bridge.inspectSession(sessionId),
          ])
          setSessionsByBot((prev) => ({ ...prev, [botId]: sessRes.sessions }))
          setInspectionBySession((prev) => ({ ...prev, [sessionId]: insp }))
          if (latestRun.runtimeId === 'codex') {
            void handleRefreshRuntime().catch(() => undefined)
          }
        } else {
          scheduleNext(120)
        }
      } catch (err) {
        stopPollingRun(run.id)
        setBannerError(err instanceof Error ? err.message : 'Failed to poll run events')
      }
    }

    void pollOnce()
  }

  useEffect(() => {
    const bridge = window.ghostBot
    if (!bridge || !activeBotId || !botsLoaded) return

    let cancelled = false
    const syncSessions = async () => {
      try {
        let listRes = await bridge.listSessions({ agentId: activeBotId })
        if (cancelled) return

        if (listRes.sessions.length === 0) {
          const created = await bridge.createSession({
            agentId: activeBotId,
            title: 'New conversation',
          })
          if (cancelled) return
          listRes = {
            sessions: [created],
            activeSessionId: created.id,
            total: 1,
          }
        }

        const chosenSessionId = listRes.activeSessionId ?? listRes.sessions[0]?.id ?? null
        setSessionsByBot((prev) => ({ ...prev, [activeBotId]: listRes.sessions }))
        setActiveSessionByBot((prev) => ({ ...prev, [activeBotId]: chosenSessionId }))

        if (chosenSessionId) {
          const chosenSession = listRes.sessions.find((s) => s.id === chosenSessionId)
          let activeRun: RunRecord | null = null
          if (chosenSession?.activeRunId) {
            activeRun = await bridge.getRun(chosenSession.activeRunId)
            if (cancelled) return
            setActiveRunBySession((prev) => ({ ...prev, [chosenSessionId]: activeRun }))
          }

          const [msgRes, insp] = await Promise.all([
            bridge.listMessages({ sessionId: chosenSessionId, limit: 200 }),
            bridge.inspectSession(chosenSessionId),
          ])
          if (cancelled) return
          setMessagesBySession((prev) => ({
            ...prev,
            [chosenSessionId]: msgRes.messages.map((m) => persistedToChatMessage(m, activeRun)),
          }))
          setInspectionBySession((prev) => ({ ...prev, [chosenSessionId]: insp }))

          if (activeRun && !TERMINAL_RUN_STATUSES.has(activeRun.status)) {
            startPollingRun(activeBotId, chosenSessionId, activeRun)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setBannerError(err instanceof Error ? err.message : 'Failed to load sessions')
        }
      }
    }

    void syncSessions()
    return () => {
      cancelled = true
    }
  }, [activeBotId, botsLoaded])

  const handleUpdateSettings = async (patch: AppSettingsPatch): Promise<void> => {
    const bridge = window.ghostBot
    if (bridge) {
      const updated = await bridge.updateSettings(patch)
      setSettings(updated)
      return
    }
    setSettings((prev) => {
      const next = AppSettingsSchema.parse({
        general: { ...prev.general, ...(patch.general ?? {}) },
        appearance: { ...prev.appearance, ...(patch.appearance ?? {}) },
        personalization: { ...prev.personalization, ...(patch.personalization ?? {}) },
        permissions: { ...prev.permissions, ...(patch.permissions ?? {}) },
        privacy: { ...prev.privacy, ...(patch.privacy ?? {}) },
      })
      saveUiPreferences(next.appearance)
      return next
    })
  }

  const handleResetSettings = async (): Promise<void> => {
    const bridge = window.ghostBot
    if (bridge) {
      const reset = await bridge.resetSettings()
      setSettings(reset)
      return
    }
    saveUiPreferences(DEFAULT_APP_SETTINGS.appearance)
    setSettings(DEFAULT_APP_SETTINGS)
  }

  const handleRefreshRuntime = async (): Promise<void> => {
    const bridge = window.ghostBot
    if (!bridge) return
    const [snap, providerList] = await Promise.all([
      bridge.getRuntimeSnapshot(true),
      bridge.listProviders(),
    ])
    setRuntimeSnapshot(snap)
    setProviders(providerList)
  }

  const updateAppearance = (patch: Partial<UiPreferences>) => {
    void handleUpdateSettings({ appearance: patch }).catch((err: unknown) => {
      setBannerError(err instanceof Error ? err.message : 'Failed to save appearance preference')
    })
  }

  const startResize =
    (side: 'left' | 'right') => (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = side === 'left' ? prefs.leftWidth : prefs.rightWidth

      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX
        if (side === 'left') {
          updateAppearance({ leftWidth: Math.min(360, Math.max(180, startWidth + delta)) })
        } else {
          updateAppearance({ rightWidth: Math.min(420, Math.max(220, startWidth - delta)) })
        }
      }
      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }

  const handleResizeKeyDown =
    (side: 'left' | 'right') => (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.preventDefault()
      const step = e.key === 'ArrowRight' ? 16 : -16
      if (side === 'left') {
        updateAppearance({ leftWidth: Math.min(360, Math.max(180, prefs.leftWidth + step)) })
      } else {
        updateAppearance({ rightWidth: Math.min(420, Math.max(220, prefs.rightWidth - step)) })
      }
    }

  const refreshTeams = async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      const res = await bridge.listTeams()
      setTeams(res.teams)
      setTeamsError(null)
    } catch (err) {
      setTeamsError(err instanceof Error ? err.message : 'Failed to load teams')
    }
  }

  const loadTeamWorkspace = async (teamId: string, preferredRunId?: string | null) => {
    const bridge = window.ghostBot
    if (!bridge) return
    const reqSeq = ++teamRequestSeqRef.current
    try {
      const runsRes = await bridge.listTeamRuns(teamId)
      if (reqSeq !== teamRequestSeqRef.current) return
      const runs = runsRes.runs
      setTeamRuns(runs)
      const chosenRunId =
        (preferredRunId && runs.some((r) => r.id === preferredRunId) ? preferredRunId : null) ??
        (typeof runs[0]?.id === 'string' ? runs[0].id : null)
      setActiveTeamRunId(chosenRunId)
      if (!chosenRunId) {
        setActiveTeamRun(null)
        setTeamTasks([])
        setTeamApprovals([])
        setTeamMessages([])
        setTeamDiagnostics(null)
        setTeamAggregateUsage(null)
        return
      }
      const [runObj, tasksRes, approvalsRes, messagesRes, diagObj, usageObj] = await Promise.all([
        bridge.getTeamRun(chosenRunId),
        bridge.listTeamRunTasks(chosenRunId),
        bridge.listTeamRunApprovals(chosenRunId),
        bridge.listTeamMessages({ teamId, teamRunId: chosenRunId, limit: 100 }),
        bridge.getTeamDiagnostics(chosenRunId).catch(() => null),
        bridge.getTeamAggregateUsage(chosenRunId).catch(() => null),
      ])
      if (reqSeq !== teamRequestSeqRef.current) return
      setActiveTeamRun(runObj)
      setTeamTasks(tasksRes.tasks)
      setTeamApprovals(approvalsRes.approvals)
      setTeamMessages(messagesRes.messages)
      setTeamDiagnostics(diagObj)
      setTeamAggregateUsage(usageObj)
    } catch (err) {
      if (reqSeq !== teamRequestSeqRef.current) return
      setTeamRunError(err instanceof Error ? err.message : 'Failed to load team workspace')
    }
  }

  useEffect(() => {
    if (!activeTeamId || !activeTeamRunId || !activeTeamRun) return
    const status = typeof activeTeamRun.status === 'string' ? activeTeamRun.status : ''
    const isActive =
      status === 'pending' ||
      status === 'queued' ||
      status === 'running' ||
      status === 'awaiting_approval' ||
      status === 'cancelling'
    if (!isActive) return
    const timer = window.setTimeout(() => {
      void loadTeamWorkspace(activeTeamId, activeTeamRunId)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [activeTeamId, activeTeamRunId, activeTeamRun])

  const buildDefaultTeamPlan = (team: TeamRecordDto, goal: string) => {
    const workers = team.memberBotIds.filter((id) => id !== team.leadBotId)
    if (workers.length === 0) {
      return {
        summary: `Single-lead plan for ${team.name}`,
        tasks: [
          {
            planKey: 'lead_task',
            assignedBotId: team.leadBotId,
            prompt: goal,
          },
        ],
      }
    }
    const firstWorker = workers[0]
    return {
      summary: `Coordinated plan for ${team.name}`,
      tasks: [
        {
          planKey: 'worker_research',
          assignedBotId: firstWorker,
          prompt: `Investigate and prepare findings for: ${goal}`,
        },
        {
          planKey: 'lead_synthesis',
          assignedBotId: team.leadBotId,
          prompt: `Synthesize worker findings into final response for: ${goal}`,
          dependsOn: ['worker_research'],
        },
      ],
    }
  }

  const handleSelectTeam = (teamId: string) => {
    setActiveTeamId(teamId)
    setTeamPlanPreview(null)
    setTeamPlanPreviewError(null)
    setTeamRunError(null)
    void loadTeamWorkspace(teamId)
  }

  const handleCreateTeam = async (input: CreateTeamIpcInput) => {
    const bridge = window.ghostBot
    if (!bridge) throw new Error('Desktop bridge unavailable')
    const created = await bridge.createTeam(input)
    await refreshTeams()
    handleSelectTeam(created.id)
  }

  const handleEditTeam = async (input: UpdateTeamIpcInput) => {
    const bridge = window.ghostBot
    if (!bridge) throw new Error('Desktop bridge unavailable')
    const updated = await bridge.updateTeam(input)
    await refreshTeams()
    setActiveTeamId(updated.id)
    void loadTeamWorkspace(updated.id, activeTeamRunId)
  }

  const handleArchiveTeam = async (teamId: string) => {
    const bridge = window.ghostBot
    if (!bridge) throw new Error('Desktop bridge unavailable')
    await bridge.archiveTeam(teamId)
    await refreshTeams()
    if (activeTeamId === teamId) {
      setActiveTeamId(null)
    }
  }

  const handlePreviewTeamPlan = async (goal: string) => {
    const bridge = window.ghostBot
    if (!bridge || !activeTeam) return
    setTeamPlanPreviewError(null)
    try {
      const plan = buildDefaultTeamPlan(activeTeam, goal)
      const preview = await bridge.previewTeamPlan({ teamId: activeTeam.id, plan })
      setTeamPlanPreview(preview)
    } catch (err) {
      setTeamPlanPreviewError(err instanceof Error ? err.message : 'Failed to preview DAG plan')
    }
  }

  const handleStartTeamRun = async (goal: string) => {
    const bridge = window.ghostBot
    if (!bridge || !activeTeam || startingTeamRun) return
    setStartingTeamRun(true)
    setTeamRunError(null)
    try {
      const plan = buildDefaultTeamPlan(activeTeam, goal)
      const started = await bridge.startTeamRun({
        teamId: activeTeam.id,
        goal,
        idempotencyKey: `ui-${activeTeam.id}-${Date.now()}`,
        plan,
        autoExecute: true,
      })
      const runObj =
        started.run && typeof started.run === 'object'
          ? (started.run as Record<string, unknown>)
          : started
      const runId = typeof runObj.id === 'string' ? runObj.id : null
      await loadTeamWorkspace(activeTeam.id, runId)
    } catch (err) {
      setTeamRunError(err instanceof Error ? err.message : 'Failed to start team run')
    } finally {
      setStartingTeamRun(false)
    }
  }

  const handleCancelTeamRun = async (teamRunId: string) => {
    const bridge = window.ghostBot
    if (!bridge || !activeTeam || cancellingTeamRun) return
    setCancellingTeamRun(true)
    setTeamRunError(null)
    try {
      await bridge.cancelTeamRun(teamRunId)
      await loadTeamWorkspace(activeTeam.id, teamRunId)
    } catch (err) {
      setTeamRunError(err instanceof Error ? err.message : 'Failed to cancel team run')
    } finally {
      setCancellingTeamRun(false)
    }
  }

  const handleResolveTeamApproval = async (
    runId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
  ) => {
    const bridge = window.ghostBot
    if (!bridge || !activeTeam) return
    await bridge.resolveApproval({ runId, approvalId, decision })
    await loadTeamWorkspace(activeTeam.id, activeTeamRunId)
  }

  const handleSelectBot = (id: string) => {
    setActiveTeamId(null)
    setActiveBotId(id)
    const bridge = window.ghostBot
    if (bridge) {
      void bridge.setActiveBot(id).catch((err: unknown) => {
        setBannerError(err instanceof Error ? err.message : 'Failed to persist active bot')
      })
    }
  }

  const updateActiveBotInline = (patch: Partial<WorkspaceBot>) => {
    if (!activeBot) return
    const targetId = activeBot.id
    setBots((prev) => prev.map((b) => (b.id === targetId ? { ...b, ...patch } : b)))
    const bridge = window.ghostBot
    if (bridge) {
      const ipcPatch: UpdateBotInput['patch'] = {}
      if (patch.modelId !== undefined) ipcPatch.modelId = patch.modelId
      if (
        patch.effort === 'low' ||
        patch.effort === 'medium' ||
        patch.effort === 'high'
      ) {
        ipcPatch.effort = patch.effort
      }
      if (
        patch.permission === 'read-only' ||
        patch.permission === 'ask-approval' ||
        patch.permission === 'workspace'
      ) {
        ipcPatch.permission = patch.permission
      }
      if (Object.keys(ipcPatch).length > 0) {
        void bridge.updateBot({ id: targetId, patch: ipcPatch }).catch((err: unknown) => {
          setBannerError(err instanceof Error ? err.message : 'Failed to save bot setting')
        })
      }
    }
  }

  const handleCreateBot = async (input: CreateBotInput) => {
    const bridge = window.ghostBot
    if (bridge) {
      const created = await bridge.createBot(input)
      setBots((prev) => [...prev, recordToWorkspaceBot(created)])
      setActiveBotId(created.id)
      return
    }
    const localBot: WorkspaceBot = {
      id: `bot-${Date.now()}`,
      name: input.name,
      description: input.description,
      statusLabel: 'Ready',
      avatarStatus: 'idle',
      avatar: input.avatar,
      instructions: input.instructions,
      workspacePath: input.workspacePath,
      modelId: input.modelId,
      effort: input.effort,
      permission: input.permission,
    }
    setBots((prev) => [...prev, localBot])
    setActiveBotId(localBot.id)
  }

  const handleEditBot = async (input: UpdateBotInput) => {
    const bridge = window.ghostBot
    if (bridge) {
      const updated = await bridge.updateBot(input)
      setBots((prev) =>
        prev.map((b) => (b.id === updated.id ? { ...b, ...recordToWorkspaceBot(updated) } : b)),
      )
      return
    }
    setBots((prev) =>
      prev.map((b) => (b.id === input.id ? { ...b, ...input.patch } : b)),
    )
  }

  const handleDuplicateBot = async (id: string) => {
    const bridge = window.ghostBot
    if (bridge) {
      const copy = await bridge.duplicateBot(id)
      setBots((prev) => [...prev, recordToWorkspaceBot(copy)])
      setActiveBotId(copy.id)
      return
    }
    const src = bots.find((b) => b.id === id)
    if (!src) return
    const copy: WorkspaceBot = {
      ...src,
      id: `bot-${Date.now()}`,
      name: `${src.name.slice(0, 52)} (Copy)`,
    }
    setBots((prev) => [...prev, copy])
    setActiveBotId(copy.id)
  }

  const handleDeleteBot = async (id: string) => {
    if (streamingBotId === id) {
      handleStopStream()
    }
    const bridge = window.ghostBot
    if (bridge) {
      const res = await bridge.deleteBot(id)
      setBots((prev) => prev.filter((b) => b.id !== res.deletedId))
      setActiveBotId(res.activeBotId)
      return
    }
    setBots((prev) => {
      const next = prev.filter((b) => b.id !== id)
      setActiveBotId((cur) => (cur === id ? (next[0]?.id ?? null) : cur))
      return next
    })
  }

  const handleImportSvg = async (rawSvg: string, label?: string) => {
    const bridge = window.ghostBot
    if (bridge) {
      return bridge.importAvatarSvg(rawSvg, label)
    }
    const res = sanitizeCustomSvg(rawSvg)
    if (!res.ok) throw new Error(res.reason)
    return { svgDataUrl: res.dataUrl, label }
  }

  const handlePickWorkspace = async (): Promise<string | null> => {
    const bridge = window.ghostBot
    if (!bridge) return null
    const res = await bridge.pickWorkspace()
    return res.canceled ? null : res.path
  }

  const handleReconnectRuntime = async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    try {
      const snap = await bridge.reconnectRuntime()
      setRuntimeSnapshot(snap)
      if (activeSessionId) {
        const insp = await bridge.inspectSession(activeSessionId)
        setInspectionBySession((prev) => ({ ...prev, [activeSessionId]: insp }))
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to reconnect runtime')
    }
  }

  const [pendingRetryRunId, setPendingRetryRunId] = useState<string | null>(null)

  const handleRetryRun = async (runId: string, confirmSideEffects = false) => {
    const bridge = window.ghostBot
    if (!bridge || !activeBot || !activeSessionId) return
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `retry-${Date.now()}`
      const started = await bridge.retryRun({
        runId,
        idempotencyKey,
        ...(confirmSideEffects ? { confirmSideEffects: true } : {}),
      })
      setPendingRetryRunId(null)
      runSeqCursorRef.current.set(started.run.id, 0)
      setActiveRunBySession((prev) => ({ ...prev, [activeSessionId]: started.run }))
      setInspectionBySession((prev) => ({ ...prev, [activeSessionId]: null }))
      await refreshSessionMessages(activeSessionId, started.run)
      startPollingRun(activeBot.id, activeSessionId, started.run, started.assistantMessageId)
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to retry run')
    }
  }

  const handleNewChat = async () => {
    const bridge = window.ghostBot
    if (!activeBot || !bridge) return
    try {
      const created = await bridge.createSession({
        agentId: activeBot.id,
        title: 'New conversation',
      })
      setSessionsByBot((prev) => ({
        ...prev,
        [activeBot.id]: [created, ...(prev[activeBot.id] ?? [])],
      }))
      setActiveSessionByBot((prev) => ({ ...prev, [activeBot.id]: created.id }))
      setMessagesBySession((prev) => ({ ...prev, [created.id]: [] }))
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to create conversation')
    }
  }

  const handleSelectSession = async (sessionId: string) => {
    const bridge = window.ghostBot
    if (!activeBot || !bridge) return
    try {
      await bridge.setActiveSession({ agentId: activeBot.id, sessionId })
      setActiveSessionByBot((prev) => ({ ...prev, [activeBot.id]: sessionId }))
      const msgRes = await bridge.listMessages({ sessionId, limit: 200 })
      const sess = (sessionsByBot[activeBot.id] ?? []).find((s) => s.id === sessionId)
      let activeRun: RunRecord | null = null
      if (sess?.activeRunId) {
        activeRun = await bridge.getRun(sess.activeRunId)
        setActiveRunBySession((prev) => ({ ...prev, [sessionId]: activeRun }))
      }
      setMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: msgRes.messages.map((m) => persistedToChatMessage(m, activeRun)),
      }))
      if (activeRun && !TERMINAL_RUN_STATUSES.has(activeRun.status)) {
        startPollingRun(activeBot.id, sessionId, activeRun)
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Failed to switch conversation')
    }
  }

  const handleStopStream = () => {
    const bridge = window.ghostBot
    if (bridge && activeSessionRun && !TERMINAL_RUN_STATUSES.has(activeSessionRun.status)) {
      void bridge.cancelRun(activeSessionRun.id).catch((err: unknown) => {
        setBannerError(err instanceof Error ? err.message : 'Failed to cancel run')
      })
      return
    }

    if (streamTimerRef.current !== null) {
      window.clearInterval(streamTimerRef.current)
      streamTimerRef.current = null
    }
    const targetId = streamingBotId
    setStreamingBotId(null)
    if (!targetId) return
    setMessagesByBot((prev) => ({
      ...prev,
      [targetId]: (prev[targetId] ?? []).map((m) =>
        m.role === 'assistant' && m.streaming
          ? { ...m, streaming: false, text: `${m.text} [stopped]` }
          : m,
      ),
    }))
    setBots((prev) =>
      prev.map((b) =>
        b.id === targetId ? { ...b, statusLabel: 'Ready', avatarStatus: 'idle' } : b,
      ),
    )
  }

  const handleSendMock = (overrideText?: string) => {
    if (!activeBot) return
    const bridge = window.ghostBot
    const text = (overrideText ?? draft).trim()
    if (!text) return

    if (bridge) {
      if (activeSessionIsStreaming) return
      if (!overrideText) setDraft('')
      const botId = activeBot.id
      void (async () => {
        try {
          let targetSessionId = activeSessionId
          if (!targetSessionId) {
            const created = await bridge.createSession({
              agentId: botId,
              title: text.slice(0, 60),
            })
            targetSessionId = created.id
            setSessionsByBot((prev) => ({
              ...prev,
              [botId]: [created, ...(prev[botId] ?? [])],
            }))
            setActiveSessionByBot((prev) => ({ ...prev, [botId]: created.id }))
          }

          const idempotencyKey =
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`

          const started = await bridge.startRun({
            sessionId: targetSessionId,
            idempotencyKey,
            text,
          })

          runSeqCursorRef.current.set(started.run.id, 0)
          setActiveRunBySession((prev) => ({ ...prev, [targetSessionId]: started.run }))
          setBots((prev) =>
            prev.map((b) =>
              b.id === botId ? { ...b, statusLabel: 'Thinking...', avatarStatus: 'thinking' } : b,
            ),
          )
          await refreshSessionMessages(targetSessionId, started.run)
          startPollingRun(botId, targetSessionId, started.run, started.assistantMessageId)
        } catch (err) {
          setBannerError(err instanceof Error ? err.message : 'Failed to start run')
        }
      })()
      return
    }

    if (!isMockMode || streamingBotId) return
    if (!overrideText) setDraft('')

    const botId = activeBot.id
    const botName = activeBot.name
    const toolId = `tool-${Date.now()}`
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
      timestamp: 'Just now',
    }
    const assistantMsgId = `a-${Date.now()}`
    const fullReply = text.toLowerCase().includes('approval')
      ? 'Prepared a simulated change for your review.'
      : `Simulated mock reply (${activeBot.modelId}, ${activeBot.effort}, ${activeBot.permission}): received "${text}".`
    const includeApproval = text.toLowerCase().includes('approval')

    const initialAssistant: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      text: '',
      streaming: true,
      timestamp: 'Just now',
      tools: [{ id: toolId, label: 'Simulated workspace check', status: 'running' }],
    }

    setMessagesByBot((prev) => ({
      ...prev,
      [botId]: [...(prev[botId] ?? []), userMsg, initialAssistant],
    }))
    setStreamingBotId(botId)
    setBots((prev) =>
      prev.map((b) =>
        b.id === botId ? { ...b, statusLabel: 'Thinking...', avatarStatus: 'thinking' } : b,
      ),
    )

    const words = fullReply.split(' ')
    let idx = 0
    streamTimerRef.current = window.setInterval(() => {
      idx += 1
      const partial = words.slice(0, idx).join(' ')
      const finished = idx >= words.length

      setMessagesByBot((prev) => ({
        ...prev,
        [botId]: (prev[botId] ?? []).map((m) => {
          if (m.id !== assistantMsgId || m.role !== 'assistant') return m
          return {
            ...m,
            text: partial,
            streaming: !finished,
            tools: finished
              ? [{ id: toolId, label: 'Simulated workspace check', status: 'done' }]
              : m.tools,
            approval:
              finished && includeApproval
                ? {
                    id: `app-${Date.now()}`,
                    title: 'Approval required',
                    description: `${botName} requests simulated file edit`,
                    diffTitle: 'notes.md (simulated preview)',
                    diffText: '--- a/notes.md\n+++ b/notes.md\n+ Added simulated task item',
                    decision: 'pending',
                  }
                : undefined,
          }
        }),
      }))

      if (finished) {
        if (streamTimerRef.current !== null) {
          window.clearInterval(streamTimerRef.current)
          streamTimerRef.current = null
        }
        setStreamingBotId(null)
        setBots((prev) =>
          prev.map((b) =>
            b.id === botId
              ? {
                  ...b,
                  statusLabel: includeApproval ? 'Approval needed' : 'Ready',
                  avatarStatus: includeApproval ? 'approval' : 'completed',
                }
              : b,
          ),
        )
      }
    }, 35)
  }

  const handleResolveApproval = (approvalId: string, decision: 'approved' | 'denied') => {
    if (!activeBot) return
    const bridge = window.ghostBot
    if (bridge && activeSessionRun && activeSessionId) {
      const currentMsg = (messagesBySession[activeSessionId] ?? []).find(
        (m): m is Extract<ChatMessage, { role: 'assistant' }> =>
          m.role === 'assistant' && m.approval?.id === approvalId,
      )
      if (currentMsg?.approval && currentMsg.approval.decision !== 'pending') {
        return
      }
      const argsHash = currentMsg?.approval?.argsHash
      setMessagesBySession((prev) => ({
        ...prev,
        [activeSessionId]: (prev[activeSessionId] ?? []).map((m) =>
          m.role === 'assistant' && m.approval?.id === approvalId && m.approval
            ? { ...m, approval: { ...m.approval, decision: 'resolving' } }
            : m,
        ),
      }))
      void bridge
        .resolveApproval({
          runId: activeSessionRun.id,
          approvalId,
          decision,
          ...(argsHash ? { argsHash } : {}),
        })
        .then((res) => {
          setActiveRunBySession((prev) => ({ ...prev, [activeSessionId]: res.run }))
        })
        .catch((err: unknown) => {
          setBannerError(err instanceof Error ? err.message : 'Failed to resolve approval')
          void refreshSessionMessages(activeSessionId)
        })
      return
    }

    setMessagesByBot((prev) => ({
      ...prev,
      [activeBot.id]: (prev[activeBot.id] ?? []).map((m) =>
        m.role === 'assistant' && m.approval?.id === approvalId
          ? { ...m, approval: { ...m.approval, decision } }
          : m,
      ),
    }))
    updateActiveBotInline({ statusLabel: 'Ready', avatarStatus: 'idle' })
  }

  const latestTools =
    [...activeMessages]
      .reverse()
      .find(
        (m): m is Extract<ChatMessage, { role: 'assistant' }> =>
          m.role === 'assistant' && Boolean(m.tools && m.tools.length > 0),
      )?.tools ?? []

  return (
    <div className="gb-shell">
      {!prefs.leftCollapsed && (
        <>
          <LeftSidebar
            width={prefs.leftWidth}
            bots={bots}
            activeBotId={activeTeam ? null : (activeBot?.id ?? null)}
            teams={teams}
            activeTeamId={activeTeam?.id ?? null}
            teamsLoading={hasBridge && !teamsLoaded}
            teamsError={teamsError}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectBot={handleSelectBot}
            onSelectTeam={handleSelectTeam}
            onCreateBot={() => setBotEditor({ open: true, mode: 'create' })}
            onCreateTeam={() => setTeamEditor({ open: true, mode: 'create' })}
            onOpenSettings={() => setSettingsOpen(true)}
            onCollapse={() => updateAppearance({ leftCollapsed: true })}
            isMockMode={isMockMode}
          />
          <div
            className="gb-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize left sidebar"
            tabIndex={0}
            onMouseDown={startResize('left')}
            onKeyDown={handleResizeKeyDown('left')}
          />
        </>
      )}

      <main className="gb-center">
        {activeTeam ? (
          <TeamWorkspaceView
            team={activeTeam}
            bots={bots}
            runs={teamRuns}
            activeRun={activeTeamRun}
            tasks={teamTasks}
            approvals={teamApprovals}
            messages={teamMessages}
            diagnostics={teamDiagnostics}
            planPreview={teamPlanPreview}
            planPreviewError={teamPlanPreviewError}
            runError={teamRunError}
            isMockMode={isMockMode}
            startingRun={startingTeamRun}
            cancellingRun={cancellingTeamRun}
            leftCollapsed={prefs.leftCollapsed}
            rightCollapsed={prefs.rightCollapsed}
            onSelectRun={(teamRunId) => void loadTeamWorkspace(activeTeam.id, teamRunId)}
            onPreviewPlan={handlePreviewTeamPlan}
            onStartRun={handleStartTeamRun}
            onCancelRun={handleCancelTeamRun}
            onResolveApproval={handleResolveTeamApproval}
            onEditTeam={() => setTeamEditor({ open: true, mode: 'edit' })}
            onToggleLeft={() => updateAppearance({ leftCollapsed: !prefs.leftCollapsed })}
            onToggleRight={() => updateAppearance({ rightCollapsed: !prefs.rightCollapsed })}
          />
        ) : (
          <>
            <ChatHeader
              bot={activeBot}
              leftCollapsed={prefs.leftCollapsed}
              rightCollapsed={prefs.rightCollapsed}
              isMockMode={isMockMode}
              sessions={hasBridge ? activeBotSessions : undefined}
              activeSessionId={hasBridge ? activeSessionId : undefined}
              onSelectSession={hasBridge ? (sid) => void handleSelectSession(sid) : undefined}
              onNewChat={hasBridge ? () => void handleNewChat() : undefined}
              onEditBot={() => setBotEditor({ open: true, mode: 'edit' })}
              onToggleLeft={() => updateAppearance({ leftCollapsed: !prefs.leftCollapsed })}
              onToggleRight={() => updateAppearance({ rightCollapsed: !prefs.rightCollapsed })}
            />

        {bannerError && (
          <div
            role="alert"
            style={{
              margin: '10px 24px 0',
              padding: '8px 12px',
              borderRadius: '8px',
              border: '1px solid var(--gb-danger)',
              color: 'var(--gb-danger)',
              fontSize: '13px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>{bannerError}</span>
            <button type="button" onClick={() => setBannerError(null)} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}

        {hasBridge &&
          activeSessionInspection &&
          (activeSessionInspection.quarantined ||
            activeSessionInspection.lastRun?.status === 'interrupted' ||
            activeSessionInspection.lastRun?.status === 'failed') && (
            <div
              role="region"
              aria-label="Execution recovery"
              style={{
                margin: '10px 24px 0',
                padding: '8px 12px',
                borderRadius: '8px',
                border: '1px solid var(--gb-border)',
                background: 'var(--gb-surface-elevated)',
                fontSize: '12.5px',
                display: 'flex',
                gap: '8px',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <span>
                {activeSessionInspection.quarantined
                  ? 'Previous cancellation stop is unconfirmed. Reconnect runtime or start a New chat.'
                  : activeSessionInspection.lastRun?.status === 'interrupted'
                    ? 'Previous run was interrupted. Any tool actions may have partially completed.'
                    : `Previous run failed${activeSessionInspection.lastRun?.error?.message ? `: ${activeSessionInspection.lastRun.error.message}` : '.'}`}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px' }}>
                {activeSessionInspection.quarantined && (
                  <button
                    type="button"
                    className="gb-btn-outline"
                    onClick={() => void handleReconnectRuntime()}
                  >
                    Reconnect runtime
                  </button>
                )}
                {!activeSessionInspection.quarantined &&
                  activeSessionInspection.resumable &&
                  activeSessionInspection.lastRun &&
                  (activeSessionInspection.hasToolActivity ? (
                    pendingRetryRunId === activeSessionInspection.lastRun.id ? (
                      <>
                        <button
                          type="button"
                          className="gb-btn-outline"
                          onClick={() =>
                            void handleRetryRun(activeSessionInspection.lastRun!.id, true)
                          }
                        >
                          Confirm retry (may repeat tools)
                        </button>
                        <button
                          type="button"
                          className="gb-btn-outline"
                          onClick={() => setPendingRetryRunId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="gb-btn-outline"
                        onClick={() => setPendingRetryRunId(activeSessionInspection.lastRun!.id)}
                      >
                        Retry prompt
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      className="gb-btn-outline"
                      onClick={() => void handleRetryRun(activeSessionInspection.lastRun!.id)}
                    >
                      Retry prompt
                    </button>
                  ))}
                <button type="button" className="gb-btn-outline" onClick={() => void handleNewChat()}>
                  New chat
                </button>
              </div>
            </div>
          )}

        {!botsLoaded ? (
          <div style={{ margin: 'auto', color: 'var(--gb-muted)' }}>Loading bots...</div>
        ) : activeBot ? (
          <>
            <MessageList
              bot={activeBot}
              messages={activeMessages}
              isMockMode={isMockMode}
              onReviewDiff={(app) => setDiffApproval(app)}
              onResolveApproval={handleResolveApproval}
              onUsePrompt={(text) => handleSendMock(text)}
            />

            <ChatComposer
              bot={activeBot}
              draft={draft}
              isStreaming={hasBridge ? activeSessionIsStreaming : streamingBotId !== null}
              isMockMode={isMockMode}
              runtimeSnapshot={runtimeSnapshot}
              onDraftChange={setDraft}
              onModelChange={(modelId) => updateActiveBotInline({ modelId })}
              onEffortChange={(effort) => updateActiveBotInline({ effort })}
              onPermissionChange={(permission: PermissionMode) =>
                updateActiveBotInline({ permission })
              }
              onSend={() => handleSendMock()}
              onStop={handleStopStream}
            />
          </>
        ) : (
          <div style={{ margin: 'auto', textAlign: 'center', padding: '32px' }}>
            <h2 style={{ margin: '0 0 8px' }}>No bots yet</h2>
            <p className="gb-muted" style={{ margin: '0 0 16px' }}>
              Create your first bot to configure its avatar, instructions, and workspace.
            </p>
            <button
              type="button"
              className="gb-btn-accent"
              onClick={() => setBotEditor({ open: true, mode: 'create' })}
            >
              Create your first bot
            </button>
          </div>
        )}
          </>
        )}
      </main>

      {!prefs.rightCollapsed && (
        <>
          <div
            className="gb-resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right workspace panel"
            tabIndex={0}
            onMouseDown={startResize('right')}
            onKeyDown={handleResizeKeyDown('right')}
          />
          {activeTeam ? (
            <TeamRightPanel
              width={prefs.rightWidth}
              team={activeTeam}
              bots={bots}
              activeRun={activeTeamRun}
              tasks={teamTasks}
              diagnostics={teamDiagnostics}
              aggregateUsage={teamAggregateUsage}
              isMockMode={isMockMode}
              onRefresh={() => void loadTeamWorkspace(activeTeam.id, activeTeamRunId)}
              onCollapse={() => updateAppearance({ rightCollapsed: true })}
            />
          ) : (
            <RightPanel
              width={prefs.rightWidth}
              bot={activeBot}
              activeTasks={latestTools}
              runtimeSnapshot={runtimeSnapshot}
              isMockMode={isMockMode}
              onRefreshUsage={() => void handleRefreshRuntime()}
              onReconnectRuntime={() => void handleReconnectRuntime()}
              onCollapse={() => updateAppearance({ rightCollapsed: true })}
            />
          )}
        </>
      )}

      <DiffPreviewModal approval={diffApproval} onClose={() => setDiffApproval(null)} />
      <SettingsModal
        open={settingsOpen}
        settings={settings}
        providers={providers}
        runtimeSnapshot={runtimeSnapshot}
        daemonHealth={health}
        bots={bots}
        activeBotId={activeBotId}
        onUpdateSettings={handleUpdateSettings}
        onResetSettings={handleResetSettings}
        onRefreshRuntime={handleRefreshRuntime}
        onClose={() => setSettingsOpen(false)}
      />
      <BotEditorModal
        open={botEditor.open}
        mode={botEditor.mode}
        initialBot={botEditor.mode === 'edit' ? activeBot : null}
        canPickWorkspace={hasBridge}
        canImportSvg={true}
        onSaveCreate={handleCreateBot}
        onSaveEdit={handleEditBot}
        onDuplicate={handleDuplicateBot}
        onDelete={handleDeleteBot}
        onImportSvg={handleImportSvg}
        onPickWorkspace={handlePickWorkspace}
        onClose={() => setBotEditor((prev) => ({ ...prev, open: false }))}
      />
      <TeamEditorModal
        open={teamEditor.open}
        mode={teamEditor.mode}
        initialTeam={teamEditor.mode === 'edit' ? activeTeam : null}
        bots={bots}
        onSaveCreate={handleCreateTeam}
        onSaveEdit={handleEditTeam}
        onArchive={handleArchiveTeam}
        onClose={() => setTeamEditor((prev) => ({ ...prev, open: false }))}
      />
    </div>
  )
}
