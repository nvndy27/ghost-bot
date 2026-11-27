import type { WorkspaceDirectoryEntryItem } from './workspaceFilesClient.ts'

export interface DirectoryNodeState {
  entries: WorkspaceDirectoryEntryItem[]
  loading: boolean
  error: string | null
  truncated: boolean
}

export interface WorkspaceFileTreeProps {
  rootPath: string
  directories: Record<string, DirectoryNodeState>
  expandedDirs: ReadonlySet<string>
  selectedFilePath: string | null
  onToggleDir: (relativePath: string) => void
  onSelectFile: (relativePath: string) => void
  onRefresh: () => void
}

export function WorkspaceFileTree({
  rootPath,
  directories,
  expandedDirs,
  selectedFilePath,
  onToggleDir,
  onSelectFile,
  onRefresh,
}: WorkspaceFileTreeProps) {
  const rootState = directories[''] ?? {
    entries: [],
    loading: false,
    error: null,
    truncated: false,
  }

  const renderEntries = (dirPath: string, depth: number) => {
    const state = directories[dirPath]
    if (!state) return null
    if (state.loading && state.entries.length === 0) {
      return (
        <div
          className="gb-muted"
          style={{ padding: '4px 8px', paddingLeft: `${8 + depth * 12}px`, fontSize: '11.5px' }}
        >
          Loading...
        </div>
      )
    }
    if (state.error) {
      return (
        <div
          style={{
            padding: '4px 8px',
            paddingLeft: `${8 + depth * 12}px`,
            fontSize: '11.5px',
            color: 'var(--gb-danger)',
          }}
        >
          {state.error}
        </div>
      )
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="gb-muted"
          style={{ padding: '4px 8px', paddingLeft: `${8 + depth * 12}px`, fontSize: '11.5px' }}
        >
          Empty directory.
        </div>
      )
    }

    return (
      <>
        {state.entries.map((entry) => {
          const isDir = entry.kind === 'directory'
          const expanded = isDir && expandedDirs.has(entry.relativePath)
          const selected = !isDir && selectedFilePath === entry.relativePath
          return (
            <div key={entry.relativePath}>
              <button
                type="button"
                className="gb-tree-item"
                style={{ paddingLeft: `${6 + depth * 12}px` }}
                aria-expanded={isDir ? expanded : undefined}
                aria-current={selected ? 'true' : undefined}
                data-testid={`workspace-tree-entry-${entry.relativePath}`}
                onClick={() => (isDir ? onToggleDir(entry.relativePath) : onSelectFile(entry.relativePath))}
              >
                <span aria-hidden="true" style={{ width: 14, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
                  {isDir ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      {expanded ? (
                        <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                      ) : (
                        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                      )}
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                    </svg>
                  )}
                </span>
                <span className="gb-tree-label" title={entry.relativePath}>
                  {entry.name}
                </span>
              </button>
              {isDir && expanded && renderEntries(entry.relativePath, depth + 1)}
            </div>
          )
        })}
        {state.truncated && (
          <div
            className="gb-muted"
            style={{ padding: '4px 8px', paddingLeft: `${8 + depth * 12}px`, fontSize: '11px' }}
          >
            Directory listing capped at 500 entries.
          </div>
        )}
      </>
    )
  }

  return (
    <div className="gb-tree-pane" data-testid="workspace-file-tree">
      <div className="gb-tree-header">
        <span className="gb-section-label" style={{ margin: 0 }}>
          Files
        </span>
        <button
          type="button"
          className="gb-workspace-icon-btn"
          onClick={onRefresh}
          aria-label="Refresh workspace files"
          title={rootPath}
          data-testid="workspace-files-refresh-btn"
        >
          Refresh
        </button>
      </div>
      <div className="gb-tree-scroll" role="tree" aria-label="Authorized workspace files">
        {rootState.loading && rootState.entries.length === 0 ? (
          <div className="gb-muted" style={{ padding: '8px', fontSize: '12px' }}>
            Loading workspace files...
          </div>
        ) : rootState.error ? (
          <div style={{ padding: '8px', fontSize: '12px', color: 'var(--gb-danger)' }}>
            {rootState.error}
          </div>
        ) : (
          renderEntries('', 0)
        )}
      </div>
    </div>
  )
}
