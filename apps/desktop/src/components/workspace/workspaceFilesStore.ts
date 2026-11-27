import type { OpenEditorTab } from './WorkspaceCodeEditor.tsx'
import type { DirectoryNodeState } from './WorkspaceFileTree.tsx'
import type {
  WorkspaceContextInfo,
  WorkspaceFilesTransport,
  WorkspaceSelector,
} from './workspaceFilesClient.ts'

export const WORKSPACE_STORE_LIMITS = {
  maxRetainedWorkspaces: 6,
  maxTabsPerWorkspace: 12,
} as const

export interface ScopedWorkspaceState {
  storageKey: string
  contextKey: string
  workspaceId: string
  contextInfo: WorkspaceContextInfo
  directories: Record<string, DirectoryNodeState>
  expandedDirs: string[]
  tabs: OpenEditorTab[]
  activePath: string | null
  lastTouchedAt: number
}

/**
 * In-memory only store (never persisted to localStorage) keyed by `${contextKey}::${workspaceId}`
 * so unsaved editor buffers survive panel collapse/unmount and tab switches without leaking across
 * bots, teams, or reassigned workspace identities.
 */
export class WorkspaceFilesStore {
  private readonly workspaces = new Map<string, ScopedWorkspaceState>()
  private readonly activeWorkspaceIdByContext = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private opSeq = 0

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  nextOperationId(): number {
    this.opSeq += 1
    return this.opSeq
  }

  getActiveWorkspaceState(contextKey: string): ScopedWorkspaceState | null {
    const wsId = this.activeWorkspaceIdByContext.get(contextKey)
    if (!wsId) return null
    return this.workspaces.get(`${contextKey}::${wsId}`) ?? null
  }

  setContextResolution(contextKey: string, ctx: WorkspaceContextInfo): ScopedWorkspaceState | null {
    const prevWsId = this.activeWorkspaceIdByContext.get(contextKey)
    if (!ctx.authorized || !ctx.workspaceId) {
      if (prevWsId) {
        this.workspaces.delete(`${contextKey}::${prevWsId}`)
        this.activeWorkspaceIdByContext.delete(contextKey)
      }
      this.emit()
      return null
    }

    if (prevWsId && prevWsId !== ctx.workspaceId) {
      // Workspace reassigned or root replaced: drop the old workspace entry so stale content cannot leak.
      this.workspaces.delete(`${contextKey}::${prevWsId}`)
    }

    const storageKey = `${contextKey}::${ctx.workspaceId}`
    this.activeWorkspaceIdByContext.set(contextKey, ctx.workspaceId)
    const existing = this.workspaces.get(storageKey)
    if (existing) {
      const updated: ScopedWorkspaceState = {
        ...existing,
        contextInfo: ctx,
        lastTouchedAt: Date.now(),
        tabs: existing.tabs.map((t) => ({
          ...t,
          readOnly: !ctx.canWrite,
        })),
      }
      this.workspaces.set(storageKey, updated)
      this.emit()
      return updated
    }

    const created: ScopedWorkspaceState = {
      storageKey,
      contextKey,
      workspaceId: ctx.workspaceId,
      contextInfo: ctx,
      directories: {},
      expandedDirs: [],
      tabs: [],
      activePath: null,
      lastTouchedAt: Date.now(),
    }
    this.workspaces.set(storageKey, created)
    this.evictExcessWorkspaces(storageKey)
    this.emit()
    return created
  }

  updateWorkspace(
    storageKey: string,
    updater: (prev: ScopedWorkspaceState) => ScopedWorkspaceState,
  ): void {
    const prev = this.workspaces.get(storageKey)
    if (!prev) return
    const next = updater(prev)
    this.workspaces.set(storageKey, { ...next, lastTouchedAt: Date.now() })
    this.emit()
  }

  openOrUpdateTab(storageKey: string, nextTab: OpenEditorTab): { ok: true } | { ok: false; reason: string } {
    const prev = this.workspaces.get(storageKey)
    if (!prev) return { ok: false, reason: 'Workspace is no longer active' }
    const exists = prev.tabs.some((t) => t.relativePath === nextTab.relativePath)
    if (exists) {
      this.updateWorkspace(storageKey, (curr) => ({
        ...curr,
        activePath: nextTab.relativePath,
        tabs: curr.tabs.map((t) => (t.relativePath === nextTab.relativePath ? nextTab : t)),
      }))
      return { ok: true }
    }

    let tabs = prev.tabs
    if (tabs.length >= WORKSPACE_STORE_LIMITS.maxTabsPerWorkspace) {
      const cleanIdx = tabs.findIndex((t) => t.draftContent === t.savedContent && !t.saving)
      if (cleanIdx === -1) {
        return {
          ok: false,
          reason: `Maximum ${WORKSPACE_STORE_LIMITS.maxTabsPerWorkspace} unsaved tabs open. Save or close a tab first.`,
        }
      }
      tabs = [...tabs.slice(0, cleanIdx), ...tabs.slice(cleanIdx + 1)]
    }

    this.updateWorkspace(storageKey, (curr) => ({
      ...curr,
      activePath: nextTab.relativePath,
      tabs: [...tabs, nextTab],
    }))
    return { ok: true }
  }

  async saveTab(
    transport: WorkspaceFilesTransport,
    selector: WorkspaceSelector,
    storageKey: string,
    relativePath: string,
  ): Promise<void> {
    const snapshot = this.workspaces.get(storageKey)
    if (!snapshot) return
    const tab = snapshot.tabs.find((t) => t.relativePath === relativePath)
    if (!tab || tab.readOnly || tab.saving) return

    const contentAtStart = tab.draftContent
    const expectedRevision = tab.revision
    const originWorkspaceId = snapshot.workspaceId

    this.updateWorkspace(storageKey, (curr) => ({
      ...curr,
      tabs: curr.tabs.map((t) =>
        t.relativePath === relativePath
          ? { ...t, saving: true, conflictMessage: null, errorMessage: null }
          : t,
      ),
    }))

    try {
      const res = await transport.saveFile({
        ...selector,
        workspaceId: originWorkspaceId,
        relativePath,
        content: contentAtStart,
        expectedRevision,
      })

      // Reconcile strictly against the originating storageKey/workspaceId even if user switched context.
      this.updateWorkspace(storageKey, (curr) => {
        if (curr.workspaceId !== res.workspaceId) return curr
        return {
          ...curr,
          tabs: curr.tabs.map((t) =>
            t.relativePath === relativePath
              ? {
                  ...t,
                  savedContent: contentAtStart,
                  revision: res.revision,
                  saving: false,
                  conflictMessage: null,
                  errorMessage: null,
                }
              : t,
          ),
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save file'
      const isConflict =
        message.toLowerCase().includes('modified on disk') ||
        message.toLowerCase().includes('conflict')
      this.updateWorkspace(storageKey, (curr) => ({
        ...curr,
        tabs: curr.tabs.map((t) =>
          t.relativePath === relativePath
            ? {
                ...t,
                saving: false,
                conflictMessage: isConflict ? message : null,
                errorMessage: isConflict ? null : message,
              }
            : t,
        ),
      }))
    }
  }

  resetForTests(): void {
    this.workspaces.clear()
    this.activeWorkspaceIdByContext.clear()
    this.emit()
  }

  private evictExcessWorkspaces(keepKey: string): void {
    if (this.workspaces.size <= WORKSPACE_STORE_LIMITS.maxRetainedWorkspaces) return
    const candidates = [...this.workspaces.values()]
      .filter((w) => w.storageKey !== keepKey)
      .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt)
    for (const candidate of candidates) {
      if (this.workspaces.size <= WORKSPACE_STORE_LIMITS.maxRetainedWorkspaces) break
      const hasDirty = candidate.tabs.some((t) => t.draftContent !== t.savedContent || t.saving)
      if (!hasDirty) {
        this.workspaces.delete(candidate.storageKey)
      }
    }
  }
}

export const sharedWorkspaceFilesStore = new WorkspaceFilesStore()
