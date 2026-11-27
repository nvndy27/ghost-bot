import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceGitInspect, WorkspaceGitOperation, WorkspaceGitResponse } from '@ghost-bot/shared-types/ipc'
import { DaemonError } from '../errors.ts'
import { normalizeWorkspaceRelativePath } from './containment.ts'
import type { WorkspaceFilesService } from './files-service.ts'
import { runGit } from './git-process.ts'
import { snapshotGitWorkspace } from './git-snapshot.ts'

type Result = WorkspaceGitResponse['result']
type Status = Extract<Result, { kind: 'status' }>
const diffOptions = ['--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all', '--no-color']
const logFormat = '%H%x00%an%x00%aI%x00%s'
const sha1 = /^[0-9a-f]{40}$/

function records(output: string): string[] {
  return output.split('\0').slice(0, -1)
}

function displayPath(path: string, omitted: Set<string>): boolean {
  try {
    if (path.length > 512 || Array.from(path).some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\ufffd')) return false
    let prefix = ''
    for (const segment of normalizeWorkspaceRelativePath(path, false)) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      if (omitted.has(prefix)) return false
    }
    return prefix === path
  } catch {
    return false
  }
}

function historyEntries(output: string): Status['history'] {
  const fields = records(output)
  const result: Status['history'] = []
  for (let i = 0; i + 3 < fields.length && result.length < 25; i += 4) {
    const [id, author, date, subject] = fields.slice(i, i + 4)
    if (sha1.test(id)) result.push({ id, author: author.slice(0, 256), date: date.slice(0, 64), subject: subject.slice(0, 512) })
  }
  return result
}

async function status(snapshot: string, omitted: Set<string>, signal: AbortSignal): Promise<Status> {
  const response = await runGit(snapshot, [
    'status', '--porcelain=v1', '-z', '--branch', '--no-renames', '--untracked-files=all', '--ignore-submodules=all',
  ], signal)
  const [heading, ...changes] = records(response.output)
  if (!heading?.startsWith('## ')) {
    throw new DaemonError('GIT_UNAVAILABLE', 'Git did not report a supported branch state.', { statusCode: 503 })
  }
  const rawBranch = heading.slice(3)
  const isUnborn = rawBranch.startsWith('No commits yet on ')
  const branch = rawBranch.startsWith('HEAD (no branch)')
    ? null
    : rawBranch.replace(/^No commits yet on /, '').split('...')[0].slice(0, 512)
  const log = isUnborn
    ? { output: '', truncated: false }
    : await runGit(snapshot, ['log', '-25', '-z', `--format=${logFormat}`, 'HEAD', '--'], signal)
  const history = historyEntries(log.output)
  const result: Status = {
    kind: 'status', branch, head: history[0]?.id ?? null, history,
    staged: [], unstaged: [], untracked: [], truncated: response.truncated || log.truncated,
  }
  for (const change of changes) {
    const path = change.slice(3)
    if (change[2] !== ' ' || !displayPath(path, omitted)) continue
    if (change.startsWith('?? ')) result.untracked.push({ path, code: '?' })
    else {
      if (change[0] !== ' ') result.staged.push({ path, code: change[0] })
      if (change[1] !== ' ') result.unstaged.push({ path, code: change[1] })
    }
    if (result.staged.length + result.unstaged.length + result.untracked.length >= 500) {
      result.truncated = true
      break
    }
  }
  return result
}

async function inspectSnapshot(input: WorkspaceGitInspect, snapshot: string, omitted: Set<string>, signal: AbortSignal): Promise<Result> {
  if (input.kind === 'status') return status(snapshot, omitted, signal)

  if (input.kind === 'diff') {
    const path = input.relativePath
    const changes = await status(snapshot, omitted, signal)
    if (!displayPath(path, omitted) || !changes[input.layer].some((change) => change.path === path)) {
      throw new DaemonError('GIT_PATH_DENIED', 'This file is outside Git inspection scope.', { statusCode: 403 })
    }
    const args = input.layer === 'untracked'
      ? ['diff', ...diffOptions.filter((flag) => flag !== '--ignore-submodules=all'), '--no-index', '--', '/dev/null', path]
      : ['diff', ...diffOptions, ...(input.layer === 'staged' ? ['--cached'] : []), '--', path]
    const result = await runGit(snapshot, args, signal)
    return { kind: 'diff', path, patch: result.output, truncated: result.truncated }
  }

  // Only commits returned by the bounded HEAD history may be inspected through IPC.
  const log = await runGit(snapshot, ['log', '-25', '-z', `--format=${logFormat}`, 'HEAD', '--'], signal)
  const commit = historyEntries(log.output).find(({ id }) => id === input.commitId)
  if (!commit) throw new DaemonError('GIT_COMMIT_UNAVAILABLE', 'Commit is outside the displayed history.', { statusCode: 404 })
  const message = await runGit(snapshot, ['show', '--no-notes', '--no-show-signature', '-s', '--format=%B', input.commitId, '--'], signal)
  const files = await runGit(snapshot, ['diff-tree', '--first-parent', '-m', '--root', '-r', '--no-commit-id', '--name-status', '-z',
    ...diffOptions, input.commitId, '--'], signal)
  const fields = records(files.output)
  const listed: { path: string; code: string }[] = []
  for (let i = 0; i + 1 < fields.length && listed.length < 500; i += 2) {
    if (displayPath(fields[i + 1], omitted)) listed.push({ code: fields[i].slice(0, 2), path: fields[i + 1] })
  }
  return {
    kind: 'commit', commit, message: message.output.slice(0, 8192), files: listed,
    truncated: message.truncated || message.output.length > 8192 || files.truncated || listed.length === 500,
  }
}

export class WorkspaceGitService {
  private readonly active = new Map<string, AbortController>()
  private readonly files: WorkspaceFilesService
  private readonly requireGrant: (access: WorkspaceGitOperation) => void

  constructor(files: WorkspaceFilesService, requireGrant: (access: WorkspaceGitOperation) => void) {
    this.files = files
    this.requireGrant = requireGrant
  }

  private key(operation: WorkspaceGitOperation) {
    return JSON.stringify([operation.botId, operation.workspaceId, operation.authGeneration, operation.operationId])
  }

  cancel(operation: WorkspaceGitOperation) {
    this.requireGrant(operation)
    const active = this.active.get(this.key(operation))
    if (!active || active.signal.aborted) return false
    active.abort()
    return true
  }

  abortAll() {
    for (const operation of this.active.values()) operation.abort()
  }

  async inspect(input: WorkspaceGitInspect, caller?: AbortSignal): Promise<WorkspaceGitResponse> {
    this.requireGrant(input)
    caller?.throwIfAborted()
    const key = this.key(input)
    if (this.active.size >= 2 || this.active.has(key)) {
      throw new DaemonError('GIT_BUSY', 'Another Git inspection is active. Try again shortly.', { statusCode: 429 })
    }
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(5000)
    const signal = AbortSignal.any([controller.signal, timeout, ...(caller ? [caller] : [])])
    this.active.set(key, controller)
    let temporary: string | undefined
    let result: Result
    try {
      const workspace = await this.files.validateDiscoveryWorkspace(input)
      try {
        if (process.platform !== 'linux' || process.getuid?.() === 0) {
          throw new DaemonError('GIT_UNAVAILABLE', 'Git inspection requires a non-root Linux sandbox.', { statusCode: 503 })
        }
        temporary = await mkdtemp(join(tmpdir(), 'ghost-workspace-git-'))
        const omitted = await snapshotGitWorkspace(workspace, temporary, signal)
        result = await inspectSnapshot(input, temporary, omitted, signal)
      } catch (err) {
        if (timeout.aborted && !controller.signal.aborted && !caller?.aborted) {
          result = { kind: 'unavailable', reason: 'Git inspection exceeded its time limit.' }
        } else if (err instanceof DaemonError && err.code === 'GIT_UNAVAILABLE') {
          result = { kind: 'unavailable', reason: err.message }
        } else throw err
      }
      this.requireGrant(input)
      await this.files.validateDiscoveryWorkspace(input)
      this.requireGrant(input)
      controller.signal.throwIfAborted()
      caller?.throwIfAborted()
      const { botId, workspaceId, authGeneration, operationId } = input
      return { botId, workspaceId, authGeneration, operationId, result }
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true })
      } finally {
        this.active.delete(key)
      }
    }
  }
}
