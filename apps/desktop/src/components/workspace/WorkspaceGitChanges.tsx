import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, Square } from 'lucide-react'
import type { WorkspaceGitInspect, WorkspaceGitOperation, WorkspaceGitResponse } from '@ghost-bot/shared-types/ipc'
import { ICON_SIZE, ICON_STROKE, IconButton } from '../IconButton.tsx'
import './workspace-git.css'

type Result = WorkspaceGitResponse['result']
type Status = Extract<Result, { kind: 'status' }>
type Detail = Extract<Result, { kind: 'commit' | 'diff' }>
type WithoutIdentity<T> = T extends WorkspaceGitOperation ? Omit<T, keyof WorkspaceGitOperation> : never
type InspectRequest = WithoutIdentity<WorkspaceGitInspect>
type Access = Omit<WorkspaceGitOperation, 'operationId'>

const layers = [
  ['staged', 'Staged'],
  ['unstaged', 'Unstaged'],
  ['untracked', 'Untracked'],
] as const

export function WorkspaceGitChanges({ botId }: { botId: string | null }) {
  const [summary, setSummary] = useState<Status | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [needsGrant, setNeedsGrant] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const active = useRef<WorkspaceGitOperation | null>(null)
  const generation = useRef(0)

  const invalidate = useCallback(() => {
    generation.current += 1
    const operation = active.current
    active.current = null
    if (operation) void window.ghostBot?.cancelWorkspaceGit(operation).catch(() => {})
  }, [])

  const run = useCallback(async (request: InspectRequest, existing?: Access) => {
    invalidate()
    const sequence = generation.current
    const bridge = window.ghostBot
    setNeedsGrant(false)
    setDetail(null)
    if (request.kind === 'status') {
      setSummary(null)
      setAccess(null)
    }
    if (!botId || typeof bridge?.inspectWorkspaceGit !== 'function') {
      setBusy(false)
      setMessage(botId ? 'Git inspection is unavailable.' : 'Git inspection requires a personal bot workspace.')
      return
    }

    setBusy(true)
    setMessage('Loading Git changes…')
    try {
      const context = await bridge.resolveWorkspaceContext({ botId })
      if (sequence !== generation.current) return
      if (!context.authorized || !context.workspaceId || !context.authGeneration) {
        setAccess(null)
        setSummary(null)
        setNeedsGrant(Boolean(context.workspaceId && context.canonicalRoot))
        setMessage(context.reason ?? 'Git inspection requires workspace read access.')
        return
      }
      const current: Access = { botId, workspaceId: context.workspaceId, authGeneration: context.authGeneration }
      if (existing && (existing.workspaceId !== current.workspaceId || existing.authGeneration !== current.authGeneration)) {
        setAccess(null)
        setSummary(null)
        setMessage('Workspace authorization changed. Refresh Git changes to continue.')
        return
      }

      const operation = { ...current, operationId: crypto.randomUUID() }
      active.current = operation
      const reply = await bridge.inspectWorkspaceGit({ ...operation, ...request })
      if (sequence !== generation.current) return
      if (reply.botId !== botId || reply.workspaceId !== operation.workspaceId ||
          reply.authGeneration !== operation.authGeneration || reply.operationId !== operation.operationId) {
        throw new Error('Workspace authorization changed. Refresh Git changes to continue.')
      }
      const result = reply.result
      if (result.kind === 'unavailable') {
        setMessage(result.reason)
      } else {
        setMessage('')
        setAccess(current)
        if (result.kind === 'status') setSummary(result)
        else setDetail(result)
      }
    } catch (err) {
      if (sequence !== generation.current) return
      setAccess(null)
      setSummary(null)
      setMessage(err instanceof Error ? err.message : 'Git inspection failed.')
    } finally {
      if (sequence === generation.current) {
        active.current = null
        setBusy(false)
      }
    }
  }, [botId, invalidate])

  useEffect(() => {
    void run({ kind: 'status' })
    return invalidate
  }, [run, invalidate])

  async function cancelInspection() {
    const operation = active.current
    const sequence = ++generation.current
    active.current = null
    setBusy(false)
    if (!operation) {
      setMessage('Git inspection stopped before submission.')
      return
    }
    setMessage('Stopping Git inspection…')
    try {
      const accepted = await window.ghostBot?.cancelWorkspaceGit(operation)
      if (sequence !== generation.current) return
      setMessage(accepted ? 'Git inspection cancelled.' : 'Git inspection is no longer active. Refresh to see changes.')
    } catch {
      if (sequence === generation.current) {
        setMessage('Git inspection cancellation could not be confirmed. Refresh to see changes.')
      }
    }
  }

  async function authorize() {
    if (!botId || !window.ghostBot) return
    invalidate()
    const sequence = generation.current
    setBusy(true)
    try {
      if (await window.ghostBot.authorizeWorkspaceRead(botId) && sequence === generation.current) {
        await run({ kind: 'status' })
      }
    } catch (err) {
      if (sequence === generation.current) {
        setMessage(err instanceof Error ? err.message : 'Workspace read access could not be granted.')
      }
    } finally {
      if (sequence === generation.current) setBusy(false)
    }
  }

  return <section className="gb-git-changes" aria-label="Git changes" data-testid="workspace-git-changes">
    <div className="gb-git-header">
      <GitBranch size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <strong>{summary ? summary.branch ?? 'Detached HEAD' : 'Git changes'}</strong>
      <span className="gb-muted">Read-only</span>
      <IconButton label="Refresh Git changes" onClick={() => void run({ kind: 'status' })} disabled={!botId}>
        <RefreshCw size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>
      {busy && <IconButton label="Cancel Git inspection" onClick={() => void cancelInspection()}>
        <Square size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </IconButton>}
    </div>
    {botId && <div className="gb-git-mutations" role="group" aria-label="Git mutation controls"
      aria-describedby="gb-git-mutation-gate">
      <button type="button" className="gb-workspace-icon-btn" disabled>Stage selected files</button>
      <button type="button" className="gb-workspace-icon-btn" disabled>Unstage selected files</button>
      <button type="button" className="gb-workspace-icon-btn" disabled>Revert file</button>
      <p className="gb-muted" id="gb-git-mutation-gate">Git writes are unavailable until the index and working tree can be protected during updates.</p>
    </div>}
    {message && <p role="status">{message}</p>}
    {needsGrant && <button type="button" className="gb-workspace-icon-btn"
      disabled={busy} onClick={() => void authorize()}>Allow read access</button>}
    {summary && access && <>
      {summary.truncated && <p className="gb-muted" role="status">Git results reached the inspection limit.</p>}
      {layers.map(([layer, label]) => <section key={layer} aria-label={label}>
        <h3>{label} ({summary[layer].length})</h3>
        {summary[layer].map(({ path, code }) => <button className="gb-git-row" key={path} type="button"
          onClick={() => void run({ kind: 'diff', relativePath: path, layer }, access)}>
          <span aria-hidden="true">{code}</span> {path}
        </button>)}
      </section>)}
      <section aria-label="Commit history">
        <h3>Commit history</h3>
        {!summary.history.length && <p className="gb-muted">No commits to show.</p>}
        {summary.history.map((commit) => <button className="gb-git-row" key={commit.id} type="button"
          onClick={() => void run({ kind: 'commit', commitId: commit.id }, access)}>
          <code>{commit.id.slice(0, 7)}</code> {commit.subject || 'Untitled commit'}
        </button>)}
      </section>
    </>}
    {detail && <section aria-label={detail.kind === 'diff' ? 'File diff' : 'Commit details'}>
      <h3>{detail.kind === 'diff' ? detail.path : detail.commit.subject}</h3>
      {detail.truncated && <p className="gb-muted" role="status">Output truncated.</p>}
      {detail.kind === 'diff' ? <pre className="gb-git-diff" data-testid="workspace-git-diff">
        {detail.patch ? detail.patch.split('\n').map((line, i) => (
          <span key={i} className={line.startsWith('+') ? 'gb-git-add' : line.startsWith('-') ? 'gb-git-delete' : undefined}>
            {line}{'\n'}
          </span>
        )) : 'No differences.'}
      </pre> : <>
        <p>{detail.commit.author} · {detail.commit.date}</p>
        <pre className="gb-git-diff">{detail.message}</pre>
        <ul>{detail.files.map(({ path, code }, i) => <li key={i}>{code} {path}</li>)}</ul>
      </>}
    </section>}
  </section>
}
