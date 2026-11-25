import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type {
  DaemonHealthResponse,
  GhostBotBridge,
  ProviderSummary,
} from '@ghost-bot/shared-types/ipc'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'
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

export function App() {
  const [prefs, setPrefs] = useState<UiPreferences>(() => loadUiPreferences())
  const [bots, setBots] = useState<WorkspaceBot[]>(() => INITIAL_MOCK_BOTS)
  const [activeBotId, setActiveBotId] = useState<string>('chief')
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [messagesByBot, setMessagesByBot] = useState<Record<string, ChatMessage[]>>(
    () => INITIAL_MOCK_MESSAGES,
  )
  const [draft, setDraft] = useState<string>('')
  const [streamingBotId, setStreamingBotId] = useState<string | null>(null)
  const [diffApproval, setDiffApproval] = useState<PendingApproval | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false)
  const [health, setHealth] = useState<DaemonHealthResponse | null>(null)
  const [providers, setProviders] = useState<ProviderSummary[]>([])

  const streamTimerRef = useRef<number | null>(null)

  const isMockMode = health === null || health.runtimeMode === 'mock'
  const activeBot = bots.find((b) => b.id === activeBotId) ?? bots[0]
  const activeMessages = messagesByBot[activeBot.id] ?? []

  // Sync theme & reduced motion attributes
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

  // Fetch daemon health & provider status over restricted preload bridge
  useEffect(() => {
    const bridge = window.ghostBot
    if (!bridge) return
    void Promise.all([bridge.getDaemonHealth(), bridge.listProviders()])
      .then(([daemonHealth, providerList]) => {
        setHealth(daemonHealth)
        setProviders(providerList)
      })
      .catch(() => {
        // Keep mock mode if daemon IPC is unavailable.
      })
  }, [])

  useEffect(() => {
    return () => {
      if (streamTimerRef.current !== null) {
        window.clearInterval(streamTimerRef.current)
      }
    }
  }, [])

  const updatePrefs = (patch: Partial<UiPreferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      saveUiPreferences(next)
      return next
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
          updatePrefs({ leftWidth: Math.min(360, Math.max(180, startWidth + delta)) })
        } else {
          updatePrefs({ rightWidth: Math.min(420, Math.max(220, startWidth - delta)) })
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
        updatePrefs({ leftWidth: Math.min(360, Math.max(180, prefs.leftWidth + step)) })
      } else {
        updatePrefs({ rightWidth: Math.min(420, Math.max(220, prefs.rightWidth - step)) })
      }
    }

  const updateActiveBot = (patch: Partial<WorkspaceBot>) => {
    setBots((prev) => prev.map((b) => (b.id === activeBot.id ? { ...b, ...patch } : b)))
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
    if (!isMockMode || streamingBotId) return
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
    setMessagesByBot((prev) => ({
      ...prev,
      [activeBot.id]: (prev[activeBot.id] ?? []).map((m) =>
        m.role === 'assistant' && m.approval?.id === approvalId
          ? { ...m, approval: { ...m.approval, decision } }
          : m,
      ),
    }))
    updateActiveBot({ statusLabel: 'Ready', avatarStatus: 'idle' })
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
            activeBotId={activeBot.id}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSelectBot={(id) => setActiveBotId(id)}
            onOpenSettings={() => setSettingsOpen(true)}
            onCollapse={() => updatePrefs({ leftCollapsed: true })}
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
          onToggleLeft={() => updatePrefs({ leftCollapsed: !prefs.leftCollapsed })}
          onToggleRight={() => updatePrefs({ rightCollapsed: !prefs.rightCollapsed })}
        />

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
          onDraftChange={setDraft}
          onModelChange={(modelId) => updateActiveBot({ modelId })}
          onEffortChange={(effort) => updateActiveBot({ effort })}
          onPermissionChange={(permission: PermissionMode) => updateActiveBot({ permission })}
          onSend={() => handleSendMock()}
          onStop={handleStopStream}
        />
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
            isMockMode={isMockMode}
            onCollapse={() => updatePrefs({ rightCollapsed: true })}
          />
        </>
      )}

      <DiffPreviewModal approval={diffApproval} onClose={() => setDiffApproval(null)} />
      <SettingsModal
        open={settingsOpen}
        preferences={prefs}
        providers={providers}
        onUpdatePreferences={updatePrefs}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
