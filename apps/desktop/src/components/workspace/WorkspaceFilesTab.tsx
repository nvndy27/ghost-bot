import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceCodeEditor, type OpenEditorTab } from './WorkspaceCodeEditor.tsx'
import { WorkspaceFileTree, type DirectoryNodeState } from './WorkspaceFileTree.tsx'
import {
  getDefaultWorkspaceFilesTransport,
  type WorkspaceContextInfo,
  type WorkspaceFilesTransport,
  type WorkspaceSelector,
} from './workspaceFilesClient.ts'
import './workspace-files.css'

export interface WorkspaceFilesTabProps {
  contextKey: string
  contextKind: 'bot' | 'team'
  ownerId: string | null
  contextLabel: string
  workspacePath?: string | null
  isMockMode: boolean
  transport?: WorkspaceFilesTransport | null
}

interface ScopedWorkspaceState {
  contextInfo: WorkspaceContextInfo | null
  directories: Record<string, DirectoryNodeState>
  expandedDirs: string[]
  tabs: OpenEditorTab[]
  activePath: string | null
}

function emptyScopedState(): ScopedWorkspaceState {
  return {
    contextInfo: null,
    directories: {},
    expandedDirs: [],
    tabs: [],
    activePath: null,
  }
}

export function WorkspaceFilesTab({
  contextKey,
  contextKind,
  ownerId,
  contextLabel,
  workspacePath,
  isMockMode,
  transport: injectedTransport,
}: WorkspaceFilesTabProps) {
  const transport = useMemo(
    () => (injectedTransport !== undefined ? injectedTransport : getDefaultWorkspaceFilesTransport()),
    [injectedTransport],
  )

  const [scopedStates, setScopedStates] = useState<Record<string, ScopedWorkspaceState>>({})
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null)
  const [loadFileError, setLoadFileError] = useState<string | null>(null)

  const requestEpochRef = useRef(0)
  const activeKeyRef = useRef(contextKey)
  activeKeyRef.current = contextKey

  const selector: WorkspaceSelector | null = useMemo(() => {
    if (!ownerId) return null
    return contextKind === 'team' ? { teamId: ownerId } : { botId: ownerId }
  }, [contextKind, ownerId])

  const currentState = scopedStates[contextKey] ?? emptyScopedState()

  const patchScopedState = useCallback(
    (targetKey: string, updater: (prev: ScopedWorkspaceState) => ScopedWorkspaceState) => {
      setScopedStates((prev) => ({
        ...prev,
        [targetKey]: updater(prev[targetKey] ?? emptyScopedState()),
      }))
    },
    [],
  )

  const loadDirectory = useCallback(
    async (
      targetKey: string,
      sel: WorkspaceSelector,
      workspaceId: string,
      relativePath: string,
      epoch: number,
    ) => {
      if (!transport) return
      patchScopedState(targetKey, (prev) => ({
        ...prev,
        directories: {
          ...prev.directories,
          [relativePath]: {
            entries: prev.directories[relativePath]?.entries ?? [],
            loading: true,
            error: null,
            truncated: prev.directories[relativePath]?.truncated ?? false,
          },
        },
      }))

      try {
        const res = await transport.listDirectory({
          ...sel,
          workspaceId,
          relativePath,
        })
        if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return
        patchScopedState(targetKey, (prev) => ({
          ...prev,
          directories: {
            ...prev.directories,
            [relativePath]: {
              entries: res.entries,
              loading: false,
              error: null,
              truncated: res.truncated,
            },
          },
        }))
      } catch (err) {
        if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return
        const message = err instanceof Error ? err.message : 'Failed to list directory'
        patchScopedState(targetKey, (prev) => ({
          ...prev,
          directories: {
            ...prev.directories,
            [relativePath]: {
              entries: prev.directories[relativePath]?.entries ?? [],
              loading: false,
              error: message,
              truncated: false,
            },
          },
        }))
      }
    },
    [patchScopedState, transport],
  )

  const refreshContextAndRoot = useCallback(async () => {
    const epoch = ++requestEpochRef.current
    const targetKey = contextKey
    setLoadFileError(null)
    setContextError(null)

    if (!transport || !selector) {
      setContextLoading(false)
      return
    }

    setContextLoading(true)
    try {
      const ctx = await transport.resolveContext(selector)
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return

      patchScopedState(targetKey, (prev) => {
        // If canonical workspace changed for this bot/team, clear stale cached tree/tabs so nothing leaks.
        const workspaceChanged =
          prev.contextInfo?.workspaceId &&
          ctx.workspaceId &&
          prev.contextInfo.workspaceId !== ctx.workspaceId
        if (!ctx.authorized || workspaceChanged) {
          return {
            ...emptyScopedState(),
            contextInfo: ctx,
          }
        }
        return {
          ...prev,
          contextInfo: ctx,
        }
      })

      if (ctx.authorized && ctx.workspaceId) {
        await loadDirectory(targetKey, selector, ctx.workspaceId, '', epoch)
      }
    } catch (err) {
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return
      setContextError(err instanceof Error ? err.message : 'Failed to resolve workspace context')
    } finally {
      if (requestEpochRef.current === epoch && activeKeyRef.current === targetKey) {
        setContextLoading(false)
      }
    }
  }, [contextKey, loadDirectory, patchScopedState, selector, transport])

  useEffect(() => {
    void refreshContextAndRoot()
  }, [refreshContextAndRoot])

  const handleToggleDir = (relativePath: string) => {
    if (!selector || !currentState.contextInfo?.workspaceId) return
    const isExpanded = currentState.expandedDirs.includes(relativePath)
    if (isExpanded) {
      patchScopedState(contextKey, (prev) => ({
        ...prev,
        expandedDirs: prev.expandedDirs.filter((d) => d !== relativePath),
      }))
      return
    }
    patchScopedState(contextKey, (prev) => ({
      ...prev,
      expandedDirs: [...prev.expandedDirs, relativePath],
    }))
    if (!currentState.directories[relativePath]) {
      void loadDirectory(
        contextKey,
        selector,
        currentState.contextInfo.workspaceId,
        relativePath,
        requestEpochRef.current,
      )
    }
  }

  const openOrReloadFile = async (relativePath: string, forceReload: boolean) => {
    if (!transport || !selector || !currentState.contextInfo?.workspaceId) return
    const existing = currentState.tabs.find((t) => t.relativePath === relativePath)
    if (existing && !forceReload) {
      patchScopedState(contextKey, (prev) => ({ ...prev, activePath: relativePath }))
      return
    }

    const epoch = requestEpochRef.current
    const targetKey = contextKey
    const targetWorkspaceId = currentState.contextInfo.workspaceId
    setLoadingFilePath(relativePath)
    setLoadFileError(null)

    try {
      const res = await transport.readFile({
        ...selector,
        workspaceId: targetWorkspaceId,
        relativePath,
      })
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return

      patchScopedState(targetKey, (prev) => {
        if (prev.contextInfo?.workspaceId !== res.workspaceId) return prev
        const nextTab: OpenEditorTab = {
          relativePath: res.relativePath,
          name: res.name,
          savedContent: res.content,
          draftContent: res.content,
          revision: res.revision,
          readOnly: res.readOnly,
          language: res.language,
          saving: false,
          conflictMessage: null,
          errorMessage: null,
        }
        const exists = prev.tabs.some((t) => t.relativePath === res.relativePath)
        return {
          ...prev,
          activePath: res.relativePath,
          tabs: exists
            ? prev.tabs.map((t) => (t.relativePath === res.relativePath ? nextTab : t))
            : [...prev.tabs, nextTab],
        }
      })
    } catch (err) {
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return
      setLoadFileError(err instanceof Error ? err.message : 'Failed to open file')
    } finally {
      if (requestEpochRef.current === epoch && activeKeyRef.current === targetKey) {
        setLoadingFilePath(null)
      }
    }
  }

  const handleSaveFile = async (relativePath: string) => {
    if (!transport || !selector || !currentState.contextInfo?.workspaceId) return
    const tab = currentState.tabs.find((t) => t.relativePath === relativePath)
    if (!tab || tab.readOnly || tab.saving) return

    const targetKey = contextKey
    const targetWorkspaceId = currentState.contextInfo.workspaceId
    const epoch = requestEpochRef.current

    patchScopedState(targetKey, (prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.relativePath === relativePath
          ? { ...t, saving: true, conflictMessage: null, errorMessage: null }
          : t,
      ),
    }))

    try {
      const res = await transport.saveFile({
        ...selector,
        workspaceId: targetWorkspaceId,
        relativePath,
        content: tab.draftContent,
        expectedRevision: tab.revision,
      })
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return

      patchScopedState(targetKey, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
          t.relativePath === relativePath
            ? {
                ...t,
                savedContent: tab.draftContent,
                revision: res.revision,
                saving: false,
                conflictMessage: null,
                errorMessage: null,
              }
            : t,
        ),
      }))
    } catch (err) {
      if (requestEpochRef.current !== epoch || activeKeyRef.current !== targetKey) return
      const message = err instanceof Error ? err.message : 'Failed to save file'
      const isConflict =
        message.toLowerCase().includes('modified on disk') ||
        message.toLowerCase().includes('conflict')
      patchScopedState(targetKey, (prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) =>
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

  if (!transport) {
    return (
      <section className="gb-workspace-placeholder" data-testid="workspace-files-unavailable">
        <div className="gb-workspace-placeholder-head">
          <strong style={{ fontSize: '13px' }}>Files / Editor</strong>
          <span className="gb-badge">Awaiting shared IPC bridge</span>
        </div>
        <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
          Daemon workspace file routes are not wired on the preload bridge yet. No filesystem
          entries are fabricated.
        </p>
        <div className="gb-workspace-placeholder-meta">
          <div>
            <span className="gb-muted">Active context: </span>
            <span>{contextLabel}</span>
            {isMockMode && (
              <span className="gb-badge" style={{ marginLeft: 6 }}>
                Mock
              </span>
            )}
          </div>
          <div>
            <span className="gb-muted">Configured workspace: </span>
            <span className="gb-workspace-path">
              {workspacePath && workspacePath.trim().length > 0 ? workspacePath : 'Not configured'}
            </span>
          </div>
        </div>
      </section>
    )
  }

  if (contextLoading && !currentState.contextInfo) {
    return (
      <div className="gb-muted" style={{ padding: '12px', fontSize: '12.5px' }}>
        Resolving authorized workspace...
      </div>
    )
  }

  if (contextError || !currentState.contextInfo || !currentState.contextInfo.authorized) {
    return (
      <section className="gb-workspace-placeholder" data-testid="workspace-files-unavailable">
        <div className="gb-workspace-placeholder-head">
          <strong style={{ fontSize: '13px' }}>Files / Editor</strong>
          <span className="gb-badge">Unavailable</span>
        </div>
        <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
          {contextError ??
            currentState.contextInfo?.reason ??
            'No authorized workspace is configured for this context.'}
        </p>
      </section>
    )
  }

  const expandedSet = new Set(currentState.expandedDirs)

  return (
    <div className="gb-files-tab" data-testid="workspace-files-tab">
      <div className="gb-files-meta-bar">
        <span
          className="gb-files-root-path"
          title={currentState.contextInfo.canonicalRoot ?? undefined}
          data-testid="workspace-files-root-path"
        >
          {currentState.contextInfo.canonicalRoot}
        </span>
        <span className="gb-badge" data-testid="workspace-files-permission-badge">
          {currentState.contextInfo.canWrite ? 'Writable' : 'Read-only'}
        </span>
      </div>

      <div className="gb-files-layout">
        <WorkspaceFileTree
          rootPath={currentState.contextInfo.canonicalRoot ?? ''}
          directories={currentState.directories}
          expandedDirs={expandedSet}
          selectedFilePath={currentState.activePath}
          onToggleDir={handleToggleDir}
          onSelectFile={(path) => void openOrReloadFile(path, false)}
          onRefresh={() => void refreshContextAndRoot()}
        />

        <WorkspaceCodeEditor
          tabs={currentState.tabs}
          activePath={currentState.activePath}
          loadingFilePath={loadingFilePath}
          loadError={loadFileError}
          onSelectTab={(path) =>
            patchScopedState(contextKey, (prev) => ({ ...prev, activePath: path }))
          }
          onChangeContent={(path, nextContent) =>
            patchScopedState(contextKey, (prev) => ({
              ...prev,
              tabs: prev.tabs.map((t) =>
                t.relativePath === path ? { ...t, draftContent: nextContent } : t,
              ),
            }))
          }
          onSaveFile={(path) => void handleSaveFile(path)}
          onReloadFile={(path) => void openOrReloadFile(path, true)}
          onDismissConflict={(path) =>
            patchScopedState(contextKey, (prev) => ({
              ...prev,
              tabs: prev.tabs.map((t) =>
                t.relativePath === path ? { ...t, conflictMessage: null } : t,
              ),
            }))
          }
          onCloseTab={(path) =>
            patchScopedState(contextKey, (prev) => {
              const remaining = prev.tabs.filter((t) => t.relativePath !== path)
              const nextActive =
                prev.activePath === path
                  ? remaining[remaining.length - 1]?.relativePath ?? null
                  : prev.activePath
              return {
                ...prev,
                tabs: remaining,
                activePath: nextActive,
              }
            })
          }
        />
      </div>
    </div>
  )
}
