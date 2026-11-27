import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { highlightCodeLines } from './syntaxHighlight.tsx'

export interface OpenEditorTab {
  relativePath: string
  name: string
  savedContent: string
  draftContent: string
  revision: string
  readOnly: boolean
  language: string
  saving: boolean
  conflictMessage: string | null
  errorMessage: string | null
}

export interface WorkspaceCodeEditorProps {
  tabs: OpenEditorTab[]
  activePath: string | null
  loadingFilePath: string | null
  loadError: string | null
  jumpTo?: { relativePath: string; lineNumber: number } | null
  onSendSelection?: (relativePath: string, text: string) => Promise<void>
  onSelectTab: (relativePath: string) => void
  onChangeContent: (relativePath: string, nextContent: string) => void
  onSaveFile: (relativePath: string) => void
  onReloadFile: (relativePath: string) => void
  onDismissConflict: (relativePath: string) => void
  onCloseTab: (relativePath: string) => void
}

export function WorkspaceCodeEditor({
  tabs,
  activePath,
  loadingFilePath,
  loadError,
  jumpTo,
  onSendSelection,
  onSelectTab,
  onChangeContent,
  onSaveFile,
  onReloadFile,
  onDismissConflict,
  onCloseTab,
}: WorkspaceCodeEditorProps) {
  const [confirmClosePath, setConfirmClosePath] = useState<string | null>(null)
  const [confirmReloadPath, setConfirmReloadPath] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [selectionLength, setSelectionLength] = useState(0)
  const [sendStatus, setSendStatus] = useState('')
  const highlightRef = useRef<HTMLPreElement | null>(null)
  const gutterRef = useRef<HTMLDivElement | null>(null)

  const activeTab = tabs.find((t) => t.relativePath === activePath) ?? null
  const isDirty = activeTab ? activeTab.draftContent !== activeTab.savedContent : false

  const lines = useMemo(() => {
    if (!activeTab) return ['']
    return activeTab.draftContent.split('\n')
  }, [activeTab])

  const highlighted = useMemo(() => {
    if (!activeTab) return null
    return highlightCodeLines(activeTab.draftContent, activeTab.language)
  }, [activeTab])

  useEffect(() => {
    setSelectionLength(0)
    setSendStatus('')
  }, [activePath])

  useEffect(() => {
    const editor = textareaRef.current
    if (!editor || !jumpTo || jumpTo.lineNumber < 1 || jumpTo.relativePath !== activePath) return
    const lineIndex = Math.min(jumpTo.lineNumber - 1, lines.length - 1)
    let offset = 0
    for (const line of lines.slice(0, lineIndex)) offset += line.length + 1
    editor.focus()
    editor.setSelectionRange(offset, offset + lines[lineIndex].length)
    const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight)
    if (Number.isFinite(lineHeight)) editor.scrollTop = lineIndex * lineHeight
  }, [jumpTo, activePath, lines])

  async function sendSelection() {
    const editor = textareaRef.current
    if (!editor || !activeTab || !onSendSelection) return
    const selection = editor.value.slice(editor.selectionStart, editor.selectionEnd)
    if (!selection.trim() || selection.length > 8000) return
    try {
      await onSendSelection(activeTab.relativePath, selection)
      setSendStatus('Selection added to the chat draft.')
    } catch (err) {
      setSendStatus(err instanceof Error ? err.message : 'The chat draft is unavailable.')
    }
  }

  const handleRequestClose = (tab: OpenEditorTab) => {
    if (tab.draftContent !== tab.savedContent) {
      setConfirmClosePath(tab.relativePath)
      return
    }
    setConfirmClosePath(null)
    onCloseTab(tab.relativePath)
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!activeTab) return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (!activeTab.readOnly && !activeTab.saving) {
        onSaveFile(activeTab.relativePath)
      }
    }
  }

  const syncScroll = (scrollTop: number, scrollLeft: number) => {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop
      highlightRef.current.scrollLeft = scrollLeft
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = scrollTop
    }
  }

  return (
    <div className="gb-editor-pane" data-testid="workspace-code-editor">
      <div className="gb-editor-tabs" role="tablist" aria-label="Open files">
        {tabs.length === 0 ? (
          <span className="gb-muted" style={{ fontSize: '11.5px', padding: '0 4px' }}>
            Select a file to inspect or edit
          </span>
        ) : (
          tabs.map((tab) => {
            const active = tab.relativePath === activePath
            const dirty = tab.draftContent !== tab.savedContent
            return (
              <div
                key={tab.relativePath}
                className={`gb-editor-tab${active ? ' active' : ''}`}
                data-testid={`editor-tab-${tab.relativePath}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  style={{ padding: 0, border: 0, background: 'transparent', fontSize: 'inherit' }}
                  onClick={() => onSelectTab(tab.relativePath)}
                  title={tab.relativePath}
                >
                  {tab.name}
                  {dirty ? ' ●' : ''}
                </button>
                <button
                  type="button"
                  className="gb-editor-tab-close"
                  aria-label={`Close ${tab.name}`}
                  data-testid={`editor-close-${tab.relativePath}`}
                  onClick={() => handleRequestClose(tab)}
                >
                  ×
                </button>
              </div>
            )
          })
        )}
      </div>

      {confirmClosePath && (
        <div className="gb-editor-banner" data-testid="editor-dirty-close-confirm">
          <span>Unsaved changes in {confirmClosePath}.</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="gb-workspace-icon-btn"
              onClick={() => {
                onSaveFile(confirmClosePath)
                setConfirmClosePath(null)
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="gb-workspace-icon-btn"
              data-testid="editor-discard-close-btn"
              onClick={() => {
                const target = confirmClosePath
                setConfirmClosePath(null)
                onCloseTab(target)
              }}
            >
              Discard
            </button>
            <button
              type="button"
              className="gb-workspace-icon-btn"
              onClick={() => setConfirmClosePath(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {loadError && (
        <div className="gb-editor-banner" data-testid="editor-load-error">
          <span style={{ color: 'var(--gb-danger)' }}>{loadError}</span>
        </div>
      )}

      {activeTab ? (
        <>
          <div className="gb-editor-toolbar">
            <span className="gb-muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeTab.relativePath} · {activeTab.language}
              {activeTab.readOnly ? ' · Read-only' : ''}
            </span>
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                type="button"
                className="gb-workspace-icon-btn"
                onClick={() => {
                  if (isDirty) {
                    setConfirmReloadPath(activeTab.relativePath)
                  } else {
                    onReloadFile(activeTab.relativePath)
                  }
                }}
                aria-label="Reload file from disk"
                data-testid="editor-reload-btn"
              >
                Reload
              </button>
              <button
                type="button"
                className="gb-workspace-icon-btn"
                disabled={activeTab.readOnly || !isDirty || activeTab.saving}
                onClick={() => onSaveFile(activeTab.relativePath)}
                aria-label="Save file"
                data-testid="editor-save-btn"
              >
                {activeTab.saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {onSendSelection && <div className="gb-workspace-discovery-controls">
            <button type="button" className="gb-workspace-icon-btn"
              disabled={!selectionLength || selectionLength > 8000}
              onClick={() => void sendSelection()}>
              Add selection to chat draft
            </button>
            {(sendStatus || selectionLength > 8000) && (
              <span role="status">{selectionLength > 8000 ? 'Select at most 8,000 characters.' : sendStatus}</span>
            )}
          </div>}
          {confirmReloadPath === activeTab.relativePath && (
            <div className="gb-editor-banner" data-testid="editor-dirty-reload-confirm">
              <span>Unsaved edits in {activeTab.name} will be discarded on reload.</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="gb-workspace-icon-btn"
                  data-testid="editor-confirm-reload-btn"
                  onClick={() => {
                    const target = confirmReloadPath
                    setConfirmReloadPath(null)
                    onReloadFile(target)
                  }}
                >
                  Reload anyway
                </button>
                <button
                  type="button"
                  className="gb-workspace-icon-btn"
                  onClick={() => setConfirmReloadPath(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {activeTab.conflictMessage && (
            <div className="gb-editor-banner" data-testid="editor-conflict-banner">
              <span style={{ color: 'var(--gb-danger)' }}>{activeTab.conflictMessage}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  type="button"
                  className="gb-workspace-icon-btn"
                  data-testid="editor-conflict-reload-btn"
                  onClick={() => onReloadFile(activeTab.relativePath)}
                >
                  Reload from disk
                </button>
                <button
                  type="button"
                  className="gb-workspace-icon-btn"
                  onClick={() => onDismissConflict(activeTab.relativePath)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {activeTab.errorMessage && !activeTab.conflictMessage && (
            <div className="gb-editor-banner" data-testid="editor-save-error">
              <span style={{ color: 'var(--gb-danger)' }}>{activeTab.errorMessage}</span>
            </div>
          )}

          <div className="gb-editor-surface">
            <div ref={gutterRef} className="gb-editor-gutter" aria-hidden="true">
              {lines.map((_, idx) => (
                <div key={idx}>{idx + 1}</div>
              ))}
            </div>
            <div className="gb-editor-code-wrap">
              <pre ref={highlightRef} className="gb-editor-highlight" aria-hidden="true">
                {highlighted}
                {activeTab.draftContent.endsWith('\n') ? '\n' : ''}
              </pre>
              <textarea
                ref={textareaRef}
                onSelect={(event) => setSelectionLength(event.currentTarget.selectionEnd - event.currentTarget.selectionStart)}
                className="gb-editor-textarea"
                aria-label={`Code editor for ${activeTab.relativePath}`}
                data-testid="workspace-editor-textarea"
                value={activeTab.draftContent}
                readOnly={activeTab.readOnly}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                onChange={(e) => onChangeContent(activeTab.relativePath, e.target.value)}
                onKeyDown={handleEditorKeyDown}
                onScroll={(e) => syncScroll(e.currentTarget.scrollTop, e.currentTarget.scrollLeft)}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="gb-muted" style={{ padding: '14px', fontSize: '12px' }}>
          {loadingFilePath
            ? `Opening ${loadingFilePath}...`
            : 'Open a text file from the authorized workspace tree to view or edit it.'}
        </div>
      )}
    </div>
  )
}
