import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import { AppSettingsSchema } from '@ghost-bot/shared-types/ipc'
import type {
  AppSettings,
  AppSettingsPatch,
  BotRecord,
  CreateBotInput,
  DaemonHealthResponse,
  GhostBotBridge,
  ProviderSummary,
  RuntimeSnapshot,
  UpdateBotInput,
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
    () => INITIAL_MOCK_MESSAGES,
  )
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

  const prefs: UiPreferences = settings.appearance
  const isMockMode = health === null || health.runtimeMode === 'mock'
  const activeBot = bots.find((b) => b.id === activeBotId) ?? bots[0] ?? null
  const activeMessages = activeBot ? (messagesByBot[activeBot.id] ?? []) : []

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
      })
      .catch((err: unknown) => {
        setBannerError(err instanceof Error ? err.message : 'Failed to load workspace state')
        setBotsLoaded(true)
      })
  }, [])

  useEffect(() => {
    return () => {
      if (streamTimerRef.current !== null) {
        window.clearInterval(streamTimerRef.current)
      }
    }
  }, [])

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

  const handleSelectBot = (id: string) => {
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

  const handleStopStream = () => {
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
    if (!activeBot || !isMockMode || streamingBotId) return
    const text = (overrideText ?? draft).trim()
    if (!text) return
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
            activeBotId={activeBot?.id ?? null}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectBot={handleSelectBot}
            onCreateBot={() => setBotEditor({ open: true, mode: 'create' })}
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
        <ChatHeader
          bot={activeBot}
          leftCollapsed={prefs.leftCollapsed}
          rightCollapsed={prefs.rightCollapsed}
          isMockMode={isMockMode}
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
              isStreaming={streamingBotId !== null}
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
          <RightPanel
            width={prefs.rightWidth}
            bot={activeBot}
            activeTasks={latestTools}
            runtimeSnapshot={runtimeSnapshot}
            isMockMode={isMockMode}
            onCollapse={() => updateAppearance({ rightCollapsed: true })}
          />
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
    </div>
  )
}
