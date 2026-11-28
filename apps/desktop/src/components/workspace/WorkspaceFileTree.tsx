import { FileCode, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
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
  canWrite?: boolean
  onToggleDir: (relativePath: string) => void
  onSelectFile: (relativePath: string) => void
  onRefresh: () => void
  onOpenFolder?: () => void
  onCreateEntry?: (kind: 'file' | 'directory', relativePath: string) => void
}

export function WorkspaceFileTree({
  rootPath,
  directories,
  expandedDirs,
  selectedFilePath,
  canWrite = false,
  onToggleDir,
  onSelectFile,
  onRefresh,
  onOpenFolder,
  onCreateEntry,
}: WorkspaceFileTreeProps) {
  const [creatingKind, setCreatingKind] = useState<'file' | 'directory' | null>(null)
  const [createPath, setCreatePath] = useState('')
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
                  {isDir ? (expanded ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />) : <FileCode size={14} aria-hidden="true" />}
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
          Explorer
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {onOpenFolder && (
            <button
              type="button"
              className="gb-icon-btn"
              onClick={onOpenFolder}
              aria-label="Open workspace folder"
              title="Open folder"
              data-testid="workspace-open-folder-btn"
            >
              <FolderOpen size={16} aria-hidden="true" />
            </button>
          )}
          {canWrite && onCreateEntry && (
            <>
              <button
                type="button"
                className="gb-icon-btn"
                onClick={() => {
                  setCreatingKind('file')
                  setCreatePath('')
                }}
                aria-label="New file" title="New file" data-testid="workspace-new-file-btn"
              >
                <FilePlus size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="gb-icon-btn"
                onClick={() => {
                  setCreatingKind('directory')
                  setCreatePath('')
                }}
                aria-label="New folder" title="New folder" data-testid="workspace-new-dir-btn"
              >
                <FolderPlus size={16} aria-hidden="true" />
              </button>
            </>
          )}
          <button
            type="button"
            className="gb-icon-btn"
            onClick={onRefresh}
            aria-label="Refresh workspace files"
            title={rootPath}
            data-testid="workspace-files-refresh-btn"
          >
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      {creatingKind && onCreateEntry && (
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '4px 6px',
            borderBottom: '1px solid var(--gb-border)',
          }}
          data-testid="workspace-create-form"
        >
          <input
            type="text"
            value={createPath}
            onChange={(e) => setCreatePath(e.target.value)}
            placeholder={creatingKind === 'file' ? 'relative/file.txt' : 'relative/dir'}
            aria-label={`New ${creatingKind} relative path`}
            data-testid="workspace-create-input"
            style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: '2px 6px' }}
          />
          <button
            type="button"
            className="gb-icon-btn"
            data-testid="workspace-create-confirm-btn"
            onClick={() => {
              const trimmed = createPath.trim()
              if (trimmed) onCreateEntry(creatingKind, trimmed)
              setCreatingKind(null)
              setCreatePath('')
            }}
          >
            Create
          </button>
          <button
            type="button"
            className="gb-icon-btn"
            onClick={() => setCreatingKind(null)}
          >
            Cancel
          </button>
        </div>
      )}
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
