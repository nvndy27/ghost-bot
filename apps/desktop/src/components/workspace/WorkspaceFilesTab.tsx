import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkspaceCodeEditor } from './WorkspaceCodeEditor.tsx'
import { WorkspaceFileTree } from './WorkspaceFileTree.tsx'
import {
  getDefaultWorkspaceFilesTransport,
  type WorkspaceFilesTransport,
  type WorkspaceSelector,
} from './workspaceFilesClient.ts'
import { sharedWorkspaceFilesStore, type WorkspaceFilesStore } from './workspaceFilesStore.ts'
import './workspace-files.css'

export interface WorkspaceFilesTabProps {
  contextKey: string
  contextKind: 'bot' | 'team'
  ownerId: string | null
  contextLabel: string
  workspacePath?: string | null
  isMockMode: boolean
  transport?: WorkspaceFilesTransport | null
  store?: WorkspaceFilesStore
}

export function WorkspaceFilesTab({
  contextKey,
  contextKind,
  ownerId,
  contextLabel,
  workspacePath,
  isMockMode,
  transport: injectedTransport,
  store = sharedWorkspaceFilesStore,
}: WorkspaceFilesTabProps) {
  const transport = useMemo(
    () => (injectedTransport !== undefined ? injectedTransport : getDefaultWorkspaceFilesTransport()),
    [injectedTransport],
  )

  const [, setVersion] = useState(0)
  const [contextLoading, setContextLoading] = useState(true)
  const [authorizing, setAuthorizing] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null)
  const [loadFileError, setLoadFileError] = useState<string | null>(null)

  const activeKeyRef = useRef<string | null>(null)
  useEffect(() => {
    activeKeyRef.current = contextKey
    return () => {
      activeKeyRef.current = null
    }
  }, [contextKey])

  useEffect(() => {
    return store.subscribe(() => setVersion((v) => v + 1))
  }, [store])

  const selector: WorkspaceSelector | null = useMemo(() => {
    if (!ownerId) return null
    return contextKind === 'team' ? { teamId: ownerId } : { botId: ownerId }
  }, [contextKind, ownerId])

  const currentState = store.getActiveWorkspaceState(contextKey)

  const loadDirectory = useCallback(
    async (
      storageKey: string,
      targetContextKey: string,
      sel: WorkspaceSelector,
      workspaceId: string,
      relativePath: string,
      opId: number,
    ) => {
      if (!transport) return
      store.updateWorkspace(storageKey, (prev) => ({
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
          authGeneration:
            store.getActiveWorkspaceState(targetContextKey)?.contextInfo.authGeneration ?? '',
          relativePath,
        })
        if (activeKeyRef.current !== targetContextKey) return
        const latest = store.getActiveWorkspaceState(targetContextKey)
        if (!latest || latest.workspaceId !== res.workspaceId) return

        store.updateWorkspace(storageKey, (prev) => ({
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
        if (activeKeyRef.current !== targetContextKey) return
        void opId
        const message = err instanceof Error ? err.message : 'Failed to list directory'
        store.updateWorkspace(storageKey, (prev) => ({
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
    [store, transport],
  )

  const refreshContextAndRoot = useCallback(async () => {
    if (activeKeyRef.current !== contextKey) return
    const opId = store.nextOperationId()
    const targetContextKey = contextKey
    setLoadFileError(null)
    setContextError(null)

    if (!transport || !selector) {
      setContextLoading(false)
      return
    }

    setContextLoading(true)
    try {
      const ctx = await transport.resolveContext(selector)
      if (activeKeyRef.current !== targetContextKey) return

      const wsState = store.setContextResolution(targetContextKey, ctx)
      if (!ctx.authorized) setContextError(ctx.reason)
      if (wsState && ctx.authorized && ctx.workspaceId) {
        await loadDirectory(
          wsState.storageKey,
          targetContextKey,
          selector,
          ctx.workspaceId,
          '',
          opId,
        )
      }
    } catch (err) {
      if (activeKeyRef.current !== targetContextKey) return
      setContextError(err instanceof Error ? err.message : 'Failed to resolve workspace context')
    } finally {
      if (activeKeyRef.current === targetContextKey) {
        setContextLoading(false)
      }
    }
  }, [contextKey, loadDirectory, selector, store, transport])

  useEffect(() => {
    void refreshContextAndRoot()
  }, [refreshContextAndRoot])

  const handleToggleDir = (relativePath: string) => {
    if (!selector || !currentState) return
    const isExpanded = currentState.expandedDirs.includes(relativePath)
    if (isExpanded) {
      store.updateWorkspace(currentState.storageKey, (prev) => ({
        ...prev,
        expandedDirs: prev.expandedDirs.filter((d) => d !== relativePath),
      }))
      return
    }
    store.updateWorkspace(currentState.storageKey, (prev) => ({
      ...prev,
      expandedDirs: [...prev.expandedDirs, relativePath],
    }))
    if (!currentState.directories[relativePath]) {
      void loadDirectory(
        currentState.storageKey,
        contextKey,
        selector,
        currentState.workspaceId,
        relativePath,
        store.nextOperationId(),
      )
    }
  }

  const openOrReloadFile = async (relativePath: string, forceReload: boolean) => {
    if (!transport || !selector || !currentState) return
    const existing = currentState.tabs.find((t) => t.relativePath === relativePath)
    if (existing && !forceReload) {
      store.updateWorkspace(currentState.storageKey, (prev) => ({
        ...prev,
        activePath: relativePath,
      }))
      return
    }

    const targetContextKey = contextKey
    const targetStorageKey = currentState.storageKey
    const targetWorkspaceId = currentState.workspaceId
    setLoadingFilePath(relativePath)
    setLoadFileError(null)

    try {
      const res = await transport.readFile({
        ...selector,
        workspaceId: targetWorkspaceId,
        authGeneration: currentState.contextInfo.authGeneration ?? '',
        relativePath,
      })
      if (activeKeyRef.current !== targetContextKey) return
      const latest = store.getActiveWorkspaceState(targetContextKey)
      if (!latest || latest.workspaceId !== res.workspaceId) return

      const outcome = store.openOrUpdateTab(targetStorageKey, {
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
      })
      if (!outcome.ok) {
        setLoadFileError(outcome.reason)
      }
    } catch (err) {
      if (activeKeyRef.current !== targetContextKey) return
      setLoadFileError(err instanceof Error ? err.message : 'Failed to open file')
    } finally {
      if (activeKeyRef.current === targetContextKey) {
        setLoadingFilePath(null)
      }
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

  if (contextLoading) {
    return (
      <div className="gb-muted" style={{ padding: '12px', fontSize: '12.5px' }}>
        Resolving authorized workspace...
      </div>
    )
  }

  if (contextError || !currentState || !currentState.contextInfo.authorized) {
    return (
      <section className="gb-workspace-placeholder" data-testid="workspace-files-unavailable">
        <div className="gb-workspace-placeholder-head">
          <strong style={{ fontSize: '13px' }}>Files / Editor</strong>
          <span className="gb-badge">Unavailable</span>
        </div>
        <p className="gb-muted" style={{ margin: 0, fontSize: '12.5px' }}>
          {contextError ??
            currentState?.contextInfo.reason ??
            'No authorized workspace is configured for this context.'}
        </p>
        {contextKind === 'bot' && ownerId && workspacePath && window.ghostBot?.authorizeWorkspaceRead && (
          <button
            type="button"
            className="gb-workspace-icon-btn"
            onClick={async () => {
              setAuthorizing(true)
              try {
                if (await window.ghostBot?.authorizeWorkspaceRead(ownerId)) {
                  await refreshContextAndRoot()
                }
              } catch (err) {
                setContextError(err instanceof Error ? err.message : 'Workspace authorization failed')
              } finally {
                setAuthorizing(false)
              }
            }}
            disabled={authorizing}
          >
            Allow read access
          </button>
        )}
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
            store.updateWorkspace(currentState.storageKey, (prev) => ({
              ...prev,
              activePath: path,
            }))
          }
          onChangeContent={(path, nextContent) =>
            store.updateWorkspace(currentState.storageKey, (prev) => ({
              ...prev,
              tabs: prev.tabs.map((t) =>
                t.relativePath === path ? { ...t, draftContent: nextContent } : t,
              ),
            }))
          }
          onSaveFile={(path) => {
            if (!selector) return
            void store.saveTab(transport, selector, currentState.storageKey, path)
          }}
          onReloadFile={(path) => void openOrReloadFile(path, true)}
          onDismissConflict={(path) =>
            store.updateWorkspace(currentState.storageKey, (prev) => ({
              ...prev,
              tabs: prev.tabs.map((t) =>
                t.relativePath === path ? { ...t, conflictMessage: null } : t,
              ),
            }))
          }
          onCloseTab={(path) =>
            store.updateWorkspace(currentState.storageKey, (prev) => {
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
