import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  AppSettingsPatch,
  MemoryRecordDto,
} from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

type MemoryCategory = MemoryRecordDto['category']
type MemoryScopeFilter = 'bot' | 'user' | 'workspace'

const MEMORY_CATEGORIES: readonly { value: MemoryCategory; label: string }[] = [
  { value: 'fact', label: 'Fact' },
  { value: 'preference', label: 'Preference' },
  { value: 'instruction_note', label: 'Instruction Note' },
  { value: 'project_context', label: 'Project Context' },
  { value: 'glossary', label: 'Glossary' },
  { value: 'other', label: 'Other' },
]

function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16)
}

export interface MemorySettingsSectionProps {
  settings: AppSettings
  bots: WorkspaceBot[]
  activeBotId?: string | null
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
}

export function MemorySettingsSection({
  settings,
  bots,
  activeBotId,
  onUpdateSettings,
}: MemorySettingsSectionProps) {
  const defaultBotId =
    activeBotId && bots.some((b) => b.id === activeBotId)
      ? activeBotId
      : (bots[0]?.id ?? '')

  const [selectedBotId, setSelectedBotId] = useState<string>(defaultBotId)
  const [scopeFilter, setScopeFilter] = useState<MemoryScopeFilter>(
    defaultBotId ? 'bot' : 'user',
  )
  const [includeArchived, setIncludeArchived] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)

  const [records, setRecords] = useState<MemoryRecordDto[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newContent, setNewContent] = useState('')
  const [newCategory, setNewCategory] = useState<MemoryCategory>('fact')
  const [newTags, setNewTags] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editCategory, setEditCategory] = useState<MemoryCategory>('fact')
  const [editTags, setEditTags] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedBotId && defaultBotId) {
      setSelectedBotId(defaultBotId)
    }
  }, [defaultBotId, selectedBotId])

  const loadMemories = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    if ((scopeFilter === 'bot' || scopeFilter === 'workspace') && !selectedBotId) {
      setRecords([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const trimmed = searchQuery.trim()
      if (trimmed) {
        const res = await bridge.searchMemories({
          query: trimmed,
          botId: scopeFilter === 'user' ? undefined : selectedBotId,
          scopeKind: scopeFilter,
          includeUserWide: scopeFilter === 'user',
          limit: 30,
        })
        setRecords(res.matches.map((m) => m.record))
      } else {
        const res = await bridge.listMemories({
          botId: scopeFilter === 'user' ? undefined : selectedBotId,
          scopeKind: scopeFilter,
          includeUserWide: scopeFilter === 'user',
          includeArchived,
          limit: 50,
          offset: 0,
        })
        setRecords(res.records)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load memories')
    } finally {
      setLoading(false)
    }
  }, [includeArchived, scopeFilter, searchQuery, selectedBotId])

  useEffect(() => {
    void loadMemories()
  }, [loadMemories])

  const handleCreate = async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    const trimmed = newContent.trim()
    if (!trimmed) return
    setCreating(true)
    setError(null)
    try {
      const scope =
        scopeFilter === 'user'
          ? ({ kind: 'user' } as const)
          : scopeFilter === 'workspace'
            ? ({ kind: 'workspace', botId: selectedBotId } as const)
            : ({ kind: 'bot', botId: selectedBotId } as const)
      await bridge.createMemory({
        scope,
        category: newCategory,
        content: trimmed,
        tags: parseTagInput(newTags),
      })
      setNewContent('')
      setNewTags('')
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create memory')
    } finally {
      setCreating(false)
    }
  }

  const startEditing = (rec: MemoryRecordDto) => {
    setEditingId(rec.id)
    setEditContent(rec.content)
    setEditCategory(rec.category)
    setEditTags(rec.tags.join(', '))
    setConfirmDeleteId(null)
  }

  const handleSaveEdit = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge) return
    const trimmed = editContent.trim()
    if (!trimmed) return
    setError(null)
    try {
      await bridge.updateMemory({
        id,
        content: trimmed,
        category: editCategory,
        tags: parseTagInput(editTags),
      })
      setEditingId(null)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update memory')
    }
  }

  const handleArchive = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setError(null)
    try {
      await bridge.archiveMemory(id)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive memory')
    }
  }

  const handleDelete = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setError(null)
    try {
      await bridge.deleteMemory(id)
      setConfirmDeleteId(null)
      await loadMemories()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete memory')
    }
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
        Memory <span className="gb-badge">Daemon-owned</span>
      </h2>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Enable memory storage</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Allow saving and managing explicit local memory records.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Enable memory storage"
          checked={settings.memory.enabled}
          onChange={(e) => void onUpdateSettings({ memory: { enabled: e.target.checked } })}
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Automatic retrieval for new runs</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Retrieve bounded active memories at dispatch. Off by default.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Automatic retrieval for new runs"
          checked={settings.memory.automaticRetrieval}
          disabled={!settings.memory.enabled}
          onChange={(e) =>
            void onUpdateSettings({ memory: { automaticRetrieval: e.target.checked } })
          }
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Include user-wide memory</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Allow bot runs to read explicit user-wide memories alongside bot scope.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Include user-wide memory"
          checked={settings.memory.includeUserWide}
          disabled={!settings.memory.enabled}
          onChange={(e) =>
            void onUpdateSettings({ memory: { includeUserWide: e.target.checked } })
          }
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Send memory to external providers</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Required before including retrieved memory in Codex or other external requests.
            Deleting local memory later cannot remove data already sent to a provider.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Send memory to external providers"
          checked={settings.memory.externalProviderConsent}
          disabled={!settings.memory.enabled}
          onChange={(e) =>
            void onUpdateSettings({ memory: { externalProviderConsent: e.target.checked } })
          }
        />
      </div>

      <div
        style={{
          marginTop: '14px',
          paddingTop: '14px',
          borderTop: '1px solid var(--gb-border)',
          display: 'grid',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="gb-select"
            aria-label="Memory scope"
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value as MemoryScopeFilter)}
          >
            <option value="bot">Bot scope</option>
            <option value="workspace">Workspace scope</option>
            <option value="user">User-wide scope</option>
          </select>

          {(scopeFilter === 'bot' || scopeFilter === 'workspace') && (
            <select
              className="gb-select"
              aria-label="Memory bot"
              value={selectedBotId}
              onChange={(e) => setSelectedBotId(e.target.value)}
            >
              {bots.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}

          <input
            type="text"
            className="gb-input"
            aria-label="Search memories"
            placeholder="Search memories..."
            value={searchQuery}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isComposing) {
                void loadMemories()
              }
            }}
            style={{ flex: 1, minWidth: '160px' }}
          />
          {searchQuery && (
            <button
              type="button"
              className="gb-btn"
              onClick={() => setSearchQuery('')}
            >
              Clear
            </button>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Archived
          </label>
        </div>

        <div
          style={{
            border: '1px solid var(--gb-border)',
            borderRadius: '8px',
            padding: '10px',
            display: 'grid',
            gap: '8px',
          }}
        >
          <textarea
            className="gb-input"
            aria-label="New memory content"
            rows={2}
            placeholder="Add an explicit memory note (no credentials or secrets)..."
            value={newContent}
            disabled={!settings.memory.enabled || creating}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="gb-select"
              aria-label="Memory category"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as MemoryCategory)}
            >
              {MEMORY_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="gb-input"
              aria-label="Memory tags"
              placeholder="Tags (comma-separated)"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              style={{ flex: 1, minWidth: '140px' }}
            />
            <button
              type="button"
              className="gb-btn gb-btn-primary"
              disabled={!settings.memory.enabled || creating || !newContent.trim()}
              onClick={() => void handleCreate()}
            >
              {creating ? 'Saving...' : 'Save memory'}
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" style={{ color: 'var(--gb-danger, #dc2626)', fontSize: '12px' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="gb-muted" style={{ fontSize: '13px' }}>
            Loading memories...
          </div>
        ) : records.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: '13px' }}>
            No memories found for this scope.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {records.map((rec) => (
              <div
                key={rec.id}
                style={{
                  border: '1px solid var(--gb-border)',
                  borderRadius: '8px',
                  padding: '10px',
                  display: 'grid',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <span className="gb-badge">{rec.scopeKind}</span>
                  <span className="gb-badge">{rec.category}</span>
                  {rec.status === 'archived' && <span className="gb-badge">archived</span>}
                  {rec.tags.map((tag) => (
                    <span key={tag} className="gb-badge">
                      #{tag}
                    </span>
                  ))}
                  <span className="gb-muted" style={{ fontSize: '11px', marginLeft: 'auto' }}>
                    {new Date(rec.updatedAt).toLocaleString()}
                  </span>
                </div>

                {editingId === rec.id ? (
                  <div style={{ display: 'grid', gap: '6px' }}>
                    <textarea
                      className="gb-input"
                      aria-label="Edit memory content"
                      rows={2}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <select
                        className="gb-select"
                        aria-label="Edit memory category"
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
                      >
                        {MEMORY_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        className="gb-input"
                        aria-label="Edit memory tags"
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="gb-btn gb-btn-primary"
                        onClick={() => void handleSaveEdit(rec.id)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="gb-btn"
                        onClick={() => setEditingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap' }}>{rec.content}</div>
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                      {rec.status === 'active' && (
                        <>
                          <button
                            type="button"
                            className="gb-btn"
                            onClick={() => startEditing(rec)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="gb-btn"
                            onClick={() => void handleArchive(rec.id)}
                          >
                            Archive
                          </button>
                        </>
                      )}
                      {confirmDeleteId === rec.id ? (
                        <>
                          <button
                            type="button"
                            className="gb-btn gb-btn-danger"
                            onClick={() => void handleDelete(rec.id)}
                          >
                            Confirm delete
                          </button>
                          <button
                            type="button"
                            className="gb-btn"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="gb-btn"
                          onClick={() => setConfirmDeleteId(rec.id)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
