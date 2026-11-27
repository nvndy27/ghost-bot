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
                <span aria-hidden="true" style={{ width: 14, textAlign: 'center', flexShrink: 0 }}>
                  {isDir ? (expanded ? '▾' : '▸') : '·'}
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
