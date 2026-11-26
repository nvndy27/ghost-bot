import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppSettings,
  AppSettingsPatch,
  KnowledgeCitationDto,
  KnowledgeCollectionDto,
  KnowledgeDocumentDto,
} from '@ghost-bot/shared-types/ipc'
import type { WorkspaceBot } from '../types/workspace.ts'

type KnowledgeScopeFilter = 'bot' | 'user' | 'workspace'
type KnowledgeSourceFormat = 'direct_text' | 'markdown'

function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 16)
}

export interface KnowledgeSettingsSectionProps {
  settings: AppSettings
  bots: WorkspaceBot[]
  activeBotId?: string | null
  onUpdateSettings: (patch: AppSettingsPatch) => Promise<void>
}

interface SearchHit {
  document: KnowledgeDocumentDto
  citation: KnowledgeCitationDto
  score: number
}

export function KnowledgeSettingsSection({
  settings,
  bots,
  activeBotId,
  onUpdateSettings,
}: KnowledgeSettingsSectionProps) {
  const defaultBotId =
    activeBotId && bots.some((b) => b.id === activeBotId)
      ? activeBotId
      : (bots[0]?.id ?? '')

  const [selectedBotId, setSelectedBotId] = useState<string>(defaultBotId)
  const [scopeFilter, setScopeFilter] = useState<KnowledgeScopeFilter>(
    defaultBotId ? 'bot' : 'user',
  )
  const [collections, setCollections] = useState<KnowledgeCollectionDto[]>([])
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('')
  const [newCollectionName, setNewCollectionName] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)

  const [documents, setDocuments] = useState<KnowledgeDocumentDto[]>([])
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newTitle, setNewTitle] = useState('')
  const [newFormat, setNewFormat] = useState<KnowledgeSourceFormat>('markdown')
  const [newTags, setNewTags] = useState('')
  const [newText, setNewText] = useState('')
  const [ingesting, setIngesting] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editTags, setEditTags] = useState('')

  const [replacingId, setReplacingId] = useState<string | null>(null)
  const [replaceText, setReplaceText] = useState('')
  const [replaceFormat, setReplaceFormat] = useState<KnowledgeSourceFormat>('markdown')

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    if (!selectedBotId && defaultBotId) {
      setSelectedBotId(defaultBotId)
    }
  }, [defaultBotId, selectedBotId])

  useEffect(() => {
    setSelectedCollectionId('')
    setEditingId(null)
    setReplacingId(null)
    setConfirmDeleteId(null)
  }, [scopeFilter, selectedBotId])

  const buildScope = useCallback(() => {
    if (scopeFilter === 'user') return { kind: 'user' } as const
    if (scopeFilter === 'workspace') return { kind: 'workspace', botId: selectedBotId } as const
    return { kind: 'bot', botId: selectedBotId } as const
  }, [scopeFilter, selectedBotId])

  const loadKnowledge = useCallback(async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    const seq = ++loadSeqRef.current
    if ((scopeFilter === 'bot' || scopeFilter === 'workspace') && !selectedBotId) {
      setCollections([])
      setDocuments([])
      setSearchHits(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const colRes = await bridge.listKnowledgeCollections({
        botId: scopeFilter === 'user' ? undefined : selectedBotId,
        scopeKind: scopeFilter,
        includeUserWide: scopeFilter === 'user',
      })
      if (seq !== loadSeqRef.current) return
      setCollections(colRes.collections)

      const trimmed = searchQuery.trim()
      if (trimmed) {
        const res = await bridge.searchKnowledgeDocuments({
          query: trimmed,
          botId: scopeFilter === 'user' ? undefined : selectedBotId,
          scopeKind: scopeFilter,
          collectionId: selectedCollectionId || undefined,
          includeUserWide: scopeFilter === 'user',
          limit: 25,
        })
        if (seq !== loadSeqRef.current) return
        setSearchHits(res.matches)
        setDocuments(res.matches.map((m) => m.document))
      } else {
        const res = await bridge.listKnowledgeDocuments({
          botId: scopeFilter === 'user' ? undefined : selectedBotId,
          scopeKind: scopeFilter,
          collectionId: selectedCollectionId || undefined,
          includeUserWide: scopeFilter === 'user',
          includeArchived,
          limit: 50,
          offset: 0,
        })
        if (seq !== loadSeqRef.current) return
        setSearchHits(null)
        setDocuments(res.documents)
      }
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setError(err instanceof Error ? err.message : 'Failed to load knowledge documents')
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
      }
    }
  }, [includeArchived, scopeFilter, searchQuery, selectedBotId, selectedCollectionId])

  useEffect(() => {
    void loadKnowledge()
  }, [loadKnowledge])

  const handleCreateCollection = async () => {
    const bridge = window.ghostBot
    if (!bridge || !newCollectionName.trim()) return
    setError(null)
    try {
      const created = await bridge.createKnowledgeCollection({
        scope: buildScope(),
        name: newCollectionName.trim(),
        description: '',
      })
      setNewCollectionName('')
      setSelectedCollectionId(created.id)
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create collection')
    }
  }

  const handleIngestText = async () => {
    const bridge = window.ghostBot
    if (!bridge || !newTitle.trim() || !newText.trim()) return
    setIngesting(true)
    setError(null)
    try {
      await bridge.ingestKnowledgeText({
        scope: buildScope(),
        collectionId: selectedCollectionId || null,
        title: newTitle.trim(),
        sourceType: newFormat,
        text: newText,
        tags: parseTagInput(newTags),
      })
      setNewTitle('')
      setNewTags('')
      setNewText('')
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to ingest document')
    } finally {
      setIngesting(false)
    }
  }

  const handlePickAndIngestFile = async () => {
    const bridge = window.ghostBot
    if (!bridge) return
    setIngesting(true)
    setError(null)
    try {
      const res = await bridge.pickAndIngestKnowledgeFile({
        scope: buildScope(),
        collectionId: selectedCollectionId || null,
        tags: parseTagInput(newTags),
      })
      if (!res.canceled) {
        await loadKnowledge()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import file')
    } finally {
      setIngesting(false)
    }
  }

  const handleSaveMetadata = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge || !editTitle.trim()) return
    setError(null)
    try {
      await bridge.updateKnowledgeDocument({
        id,
        title: editTitle.trim(),
        tags: parseTagInput(editTags),
      })
      setEditingId(null)
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update document')
    }
  }

  const handleReplaceText = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge || !replaceText.trim()) return
    setError(null)
    try {
      await bridge.replaceKnowledgeDocumentText({
        id,
        sourceType: replaceFormat,
        text: replaceText,
      })
      setReplacingId(null)
      setReplaceText('')
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to replace document')
    }
  }

  const handleArchive = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setError(null)
    try {
      await bridge.archiveKnowledgeDocument(id)
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive document')
    }
  }

  const handleDelete = async (id: string) => {
    const bridge = window.ghostBot
    if (!bridge) return
    setError(null)
    try {
      await bridge.deleteKnowledgeDocument(id)
      setConfirmDeleteId(null)
      await loadKnowledge()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete document')
    }
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 12px', fontSize: '17px' }}>
        Knowledge <span className="gb-badge">Daemon-owned</span>
      </h2>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Enable knowledge storage</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Allow ingesting and managing local UTF-8 TXT and Markdown documents.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Enable knowledge storage"
          checked={settings.knowledge.enabled}
          onChange={(e) => void onUpdateSettings({ knowledge: { enabled: e.target.checked } })}
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Automatic document retrieval</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Retrieve bounded relevant document chunks at dispatch. Off by default.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Automatic document retrieval"
          checked={settings.knowledge.automaticRetrieval}
          disabled={!settings.knowledge.enabled}
          onChange={(e) =>
            void onUpdateSettings({ knowledge: { automaticRetrieval: e.target.checked } })
          }
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Include user-wide documents</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Allow bot runs to search explicit user-wide documents alongside bot/workspace scopes.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Include user-wide documents"
          checked={settings.knowledge.includeUserWide}
          disabled={!settings.knowledge.enabled}
          onChange={(e) =>
            void onUpdateSettings({ knowledge: { includeUserWide: e.target.checked } })
          }
        />
      </div>

      <div className="gb-setting-row">
        <div>
          <div style={{ fontWeight: 500 }}>Send documents to external providers</div>
          <div className="gb-muted" style={{ fontSize: '12px' }}>
            Independent consent required before attaching document excerpts to Codex or external
            requests. Deleting local documents cannot remove data already sent; start a New chat
            to avoid reusing an existing provider thread.
          </div>
        </div>
        <input
          type="checkbox"
          aria-label="Send documents to external providers"
          checked={settings.knowledge.externalProviderConsent}
          disabled={!settings.knowledge.enabled}
          onChange={(e) =>
            void onUpdateSettings({ knowledge: { externalProviderConsent: e.target.checked } })
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
            aria-label="Knowledge scope"
            value={scopeFilter}
            onChange={(e) => setScopeFilter(e.target.value as KnowledgeScopeFilter)}
          >
            <option value="bot">Bot scope</option>
            <option value="workspace">Workspace scope</option>
            <option value="user">User-wide scope</option>
          </select>

          {(scopeFilter === 'bot' || scopeFilter === 'workspace') && (
            <select
              className="gb-select"
              aria-label="Knowledge bot"
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

          <select
            className="gb-select"
            aria-label="Knowledge collection"
            value={selectedCollectionId}
            onChange={(e) => setSelectedCollectionId(e.target.value)}
          >
            <option value="">All collections</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            className="gb-input"
            aria-label="New collection name"
            placeholder="New collection name..."
            value={newCollectionName}
            disabled={!settings.knowledge.enabled}
            onChange={(e) => setNewCollectionName(e.target.value)}
            style={{ width: '180px' }}
          />
          <button
            type="button"
            className="gb-btn"
            disabled={!settings.knowledge.enabled || !newCollectionName.trim()}
            onClick={() => void handleCreateCollection()}
          >
            Create collection
          </button>

          <input
            type="text"
            className="gb-input"
            aria-label="Search documents"
            placeholder="Search documents..."
            value={searchQuery}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isComposing) {
                void loadKnowledge()
              }
            }}
            style={{ flex: 1, minWidth: '150px' }}
          />
          {searchQuery && (
            <button type="button" className="gb-btn" onClick={() => setSearchQuery('')}>
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
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              className="gb-input"
              aria-label="Document title"
              placeholder="Document title..."
              value={newTitle}
              disabled={!settings.knowledge.enabled || ingesting}
              onChange={(e) => setNewTitle(e.target.value)}
              style={{ flex: 1, minWidth: '160px' }}
            />
            <select
              className="gb-select"
              aria-label="Document format"
              value={newFormat}
              onChange={(e) => setNewFormat(e.target.value as KnowledgeSourceFormat)}
            >
              <option value="markdown">Markdown</option>
              <option value="direct_text">Plain Text</option>
            </select>
            <button
              type="button"
              className="gb-btn"
              disabled={!settings.knowledge.enabled || ingesting}
              onClick={() => void handlePickAndIngestFile()}
            >
              Import TXT / MD file
            </button>
          </div>
          <textarea
            className="gb-input"
            aria-label="Document content"
            rows={3}
            placeholder="Paste UTF-8 text or Markdown content (no credentials or secrets)..."
            value={newText}
            disabled={!settings.knowledge.enabled || ingesting}
            onChange={(e) => setNewText(e.target.value)}
          />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              className="gb-input"
              aria-label="Document tags"
              placeholder="Tags (comma-separated)"
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              style={{ flex: 1, minWidth: '140px' }}
            />
            <button
              type="button"
              className="gb-btn gb-btn-primary"
              disabled={
                !settings.knowledge.enabled || ingesting || !newTitle.trim() || !newText.trim()
              }
              onClick={() => void handleIngestText()}
            >
              {ingesting ? 'Ingesting...' : 'Save document'}
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
            Loading documents...
          </div>
        ) : documents.length === 0 ? (
          <div className="gb-muted" style={{ fontSize: '13px' }}>
            No documents found for this scope.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '8px' }}>
            {searchHits
              ? searchHits.map((hit) => (
                  <div
                    key={hit.citation.chunkId}
                    style={{
                      border: '1px solid var(--gb-border)',
                      borderRadius: '8px',
                      padding: '10px',
                      display: 'grid',
                      gap: '6px',
                    }}
                  >
                    <div
                      style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}
                    >
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>
                        {hit.document.title}
                      </span>
                      <span className="gb-badge">{hit.document.scopeKind}</span>
                      <span className="gb-badge">
                        lines {hit.citation.startLine}-{hit.citation.endLine}
                      </span>
                      {hit.citation.sectionPath.length > 0 && (
                        <span className="gb-badge">{hit.citation.sectionPath.join(' › ')}</span>
                      )}
                    </div>
                    <div style={{ fontSize: '12px', whiteSpace: 'pre-wrap' }}>
                      {hit.citation.excerpt}
                    </div>
                  </div>
                ))
              : documents.map((doc) => (
                  <div
                    key={doc.id}
                    style={{
                      border: '1px solid var(--gb-border)',
                      borderRadius: '8px',
                      padding: '10px',
                      display: 'grid',
                      gap: '6px',
                    }}
                  >
                    <div
                      style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}
                    >
                      <span style={{ fontWeight: 600, fontSize: '13px' }}>{doc.title}</span>
                      <span className="gb-badge">{doc.scopeKind}</span>
                      <span className="gb-badge">{doc.sourceType}</span>
                      {doc.status === 'archived' && <span className="gb-badge">archived</span>}
                      {doc.tags.map((tag) => (
                        <span key={tag} className="gb-badge">
                          #{tag}
                        </span>
                      ))}
                      <span className="gb-muted" style={{ fontSize: '11px', marginLeft: 'auto' }}>
                        rev {doc.currentRevisionId.slice(0, 12)}
                      </span>
                    </div>

                    {editingId === doc.id ? (
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          type="text"
                          className="gb-input"
                          aria-label="Edit document title"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <input
                          type="text"
                          className="gb-input"
                          aria-label="Edit document tags"
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                          style={{ flex: 1 }}
                        />
                        <button
                          type="button"
                          className="gb-btn gb-btn-primary"
                          onClick={() => void handleSaveMetadata(doc.id)}
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
                    ) : replacingId === doc.id ? (
                      <div style={{ display: 'grid', gap: '6px' }}>
                        <textarea
                          className="gb-input"
                          aria-label="Replace document content"
                          rows={3}
                          value={replaceText}
                          onChange={(e) => setReplaceText(e.target.value)}
                        />
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <select
                            className="gb-select"
                            aria-label="Replace document format"
                            value={replaceFormat}
                            onChange={(e) =>
                              setReplaceFormat(e.target.value as KnowledgeSourceFormat)
                            }
                          >
                            <option value="markdown">Markdown</option>
                            <option value="direct_text">Plain Text</option>
                          </select>
                          <button
                            type="button"
                            className="gb-btn gb-btn-primary"
                            onClick={() => void handleReplaceText(doc.id)}
                          >
                            Confirm replace
                          </button>
                          <button
                            type="button"
                            className="gb-btn"
                            onClick={() => setReplacingId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                        {doc.status === 'ready' && (
                          <>
                            <button
                              type="button"
                              className="gb-btn"
                              onClick={() => {
                                setEditingId(doc.id)
                                setEditTitle(doc.title)
                                setEditTags(doc.tags.join(', '))
                                setReplacingId(null)
                                setConfirmDeleteId(null)
                              }}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="gb-btn"
                              onClick={() => {
                                setReplacingId(doc.id)
                                setReplaceText('')
                                setReplaceFormat(
                                  doc.sourceType === 'markdown' ? 'markdown' : 'direct_text',
                                )
                                setEditingId(null)
                                setConfirmDeleteId(null)
                              }}
                            >
                              Replace
                            </button>
                            <button
                              type="button"
                              className="gb-btn"
                              onClick={() => void handleArchive(doc.id)}
                            >
                              Archive
                            </button>
                          </>
                        )}
                        {confirmDeleteId === doc.id ? (
                          <>
                            <button
                              type="button"
                              className="gb-btn gb-btn-danger"
                              onClick={() => void handleDelete(doc.id)}
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
                            onClick={() => setConfirmDeleteId(doc.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
          </div>
        )}
      </div>
    </div>
  )
}
