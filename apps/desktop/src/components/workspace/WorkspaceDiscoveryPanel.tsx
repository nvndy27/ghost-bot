import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Search, Square } from 'lucide-react'
import { sanitizeCustomSvg } from '@ghost-bot/avatar/svg-sanitizer'
import { ICON_SIZE, ICON_STROKE, IconButton } from '../IconButton.tsx'
import type {
  PersonalWorkspaceAccess,
  WorkspaceDiscoveryTransport,
  WorkspacePreviewPayload,
  WorkspaceSearchHit,
} from './workspaceDiscoveryClient.ts'

interface Props {
  access: PersonalWorkspaceAccess
  transport: WorkspaceDiscoveryTransport
  onOpenResult: (hit: WorkspaceSearchHit) => Promise<void>
}

type SearchResult = Awaited<ReturnType<WorkspaceDiscoveryTransport['searchWorkspaceFiles']>>

export function WorkspaceSearch({ access, transport, onOpenResult }: Props) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'filename' | 'content'>('filename')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [status, setStatus] = useState('')
  const active = useRef<string | null>(null)

  const { botId, workspaceId, authGeneration } = access
  useEffect(() => () => {
    const operationId = active.current
    active.current = null
    if (operationId) {
      void transport.cancelWorkspaceDiscovery({ botId, workspaceId, authGeneration, operationId }).catch(() => {})
    }
  }, [botId, workspaceId, authGeneration, transport])

  function cancel() {
    const operationId = active.current
    if (!operationId) return
    active.current = null
    setStatus('Search cancelled.')
    void transport.cancelWorkspaceDiscovery({ ...access, operationId }).catch(() => {})
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const term = query.trim()
    if (!term) return
    cancel()
    const operationId = crypto.randomUUID()
    active.current = operationId
    setResult(null)
    setStatus('Searching…')
    try {
      const response = await transport.searchWorkspaceFiles({ ...access, operationId, mode, query: term })
      if (active.current !== operationId) return
      if (response.workspaceId !== workspaceId || response.authGeneration !== authGeneration ||
          response.operationId !== operationId) {
        setStatus('Workspace authorization changed. Refresh the workspace and try again.')
        return
      }
      setResult(response)
      const finding = response.results.length === 0 ? 'No matches.' : `${response.results.length} matches.`
      setStatus(response.truncated ? `${finding} Search reached a limit.` : finding)
    } catch (err) {
      if (active.current === operationId) {
        setStatus(err instanceof Error ? err.message : 'Workspace search failed.')
      }
    } finally {
      if (active.current === operationId) active.current = null
    }
  }

  return (
    <div className="gb-workspace-discovery">
      <form className="gb-workspace-discovery-controls" onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => { if (event.key === 'Escape' && active.current) {
          event.stopPropagation()
          cancel()
        } }}>
        <select aria-label="Search scope" value={mode}
          onChange={(event) => setMode(event.target.value === 'content' ? 'content' : 'filename')}>
          <option value="filename">File names</option>
          <option value="content">File contents</option>
        </select>
        <input aria-label="Search workspace" type="search" maxLength={128} value={query}
          onChange={(event) => setQuery(event.target.value)} />
        <IconButton label="Run workspace search" type="submit" disabled={!query.trim()}>
          <Search size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </IconButton>
        {active.current && <IconButton label="Cancel workspace search" onClick={cancel}>
          <Square size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </IconButton>}
      </form>
      <div role="status">{status}</div>
      {!!result?.results.length && (
        <ul className="gb-workspace-search-results">
          {result.results.map((hit) => (
            <li key={`${hit.relativePath}:${hit.lineNumber ?? ''}`}>
              <button type="button" onClick={() => {
                void onOpenResult(hit).catch((err: unknown) => {
                  setResult(null)
                  setStatus(err instanceof Error ? err.message : 'Could not open search result.')
                })
              }}>
                <strong>{hit.relativePath}{hit.lineNumber === null ? '' : `:${hit.lineNumber}`}</strong>
                {hit.line !== null && <code>{hit.line}</code>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MarkdownPreview({ source }: { source: string }) {
  // Render only text and a small set of block elements. URLs and inline HTML stay inert.
  return <article>
    {source.split('\n', 3000).map((line, index) => {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) return <p key={index}><strong>{heading[2]}</strong></p>
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
      if (bullet) return <p key={index}>• {bullet[1]}</p>
      return line.trim() ? <p key={index}>{line}</p> : null
    })}
  </article>
}

function PreviewContent({ preview, relativePath }: { preview: WorkspacePreviewPayload; relativePath: string }) {
  if (preview.kind === 'unavailable') return <p role="status">{preview.reason}</p>
  if (preview.kind === 'markdown') return <MarkdownPreview source={preview.text} />
  if (preview.kind === 'svg') {
    const svg = sanitizeCustomSvg(preview.text)
    return svg.ok ? <img src={svg.dataUrl} alt={relativePath} /> : <p role="status">Unsafe or unsupported SVG.</p>
  }
  if (preview.kind === 'image' || preview.kind === 'pdf') {
    const mime = preview.kind === 'pdf' ? 'image/png' : preview.mime
    return <RasterPreview src={`data:${mime};base64,${preview.base64}`}
      label={preview.kind === 'pdf' ? `${relativePath}, page ${preview.page}` : relativePath} />
  }
  return null
}

function RasterPreview({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <p role="status">Unable to decode the preview image.</p>
    : <img src={src} alt={label} onError={() => setFailed(true)} />
}

export function WorkspacePreview({ access, transport, relativePath, onClose }: {
  access: PersonalWorkspaceAccess
  transport: WorkspaceDiscoveryTransport
  relativePath: string
  onClose: () => void
}) {
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<WorkspacePreviewPayload | null>(null)
  const [status, setStatus] = useState('Loading preview…')
  const { botId, workspaceId, authGeneration } = access
  useEffect(() => {
    let current = true
    let pending = true
    const operationId = crypto.randomUUID()
    const input = { botId, workspaceId, authGeneration, operationId }
    void transport.previewWorkspaceFile({ ...input, relativePath, page }).then((result) => {
      if (!current) return
      if (result.workspaceId !== workspaceId || result.authGeneration !== authGeneration ||
          result.operationId !== operationId || result.relativePath !== relativePath) {
        setStatus('Workspace authorization changed. Refresh the workspace and try again.')
        return
      }
      setPreview(result.preview)
    }).catch((err: unknown) => {
      if (current) setStatus(err instanceof Error ? err.message : 'Could not load preview.')
    }).finally(() => { pending = false })
    return () => {
      current = false
      if (pending) void transport.cancelWorkspaceDiscovery(input).catch(() => {})
    }
  }, [botId, workspaceId, authGeneration, relativePath, page, transport])

  function turnPage(nextPage: number) {
    setPreview(null)
    setStatus('Loading preview…')
    setPage(nextPage)
  }

  return <section className="gb-workspace-preview" aria-label="File preview"
    onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }}>
    <div className="gb-workspace-discovery-controls">
      <strong>{relativePath}</strong>
      <button type="button" className="gb-workspace-icon-btn" onClick={onClose}>Close preview</button>
    </div>
    {preview?.kind === 'pdf' && <div className="gb-workspace-discovery-controls">
      <button type="button" className="gb-workspace-icon-btn" disabled={preview.page === 1}
        onClick={() => turnPage(preview.page - 1)}>Previous page</button>
      <span>Page {preview.page} of {preview.pageCount}</span>
      <button type="button" className="gb-workspace-icon-btn" disabled={preview.page === preview.pageCount}
        onClick={() => turnPage(preview.page + 1)}>Next page</button>
    </div>}
    {preview ? <PreviewContent key={page} preview={preview} relativePath={relativePath} />
      : <p role="status">{status}</p>}
  </section>
}
