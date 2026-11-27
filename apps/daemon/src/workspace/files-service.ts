import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import {
  assertDescriptorContainmentSupported,
  computeWorkspaceId,
  detectLanguageFromPath,
  listContainedDirectory,
  normalizeWorkspaceRelativePath,
  readContainedTextFile,
  saveContainedTextFile,
  type SaveHookOptions,
} from './containment.ts'
import {
  WorkspaceListDirectoryInputSchema,
  WorkspaceReadFileInputSchema,
  WorkspaceSaveFileInputSchema,
  WorkspaceSelectorSchema,
  type WorkspaceContextResponse,
  type WorkspaceListDirectoryResponse,
  type WorkspaceReadFileResponse,
  type WorkspaceSaveFileResponse,
} from './contracts.ts'

interface AgentWorkspaceRow {
  id: string
  name: string
  workspace_path: string
  permission_mode: string
  updated_at: string
  archived_at: string | null
}

interface TeamWorkspaceRow {
  id: string
  name: string
  lead_bot_id: string
  updated_at: string
  archived_at: string | null
}

export interface AuthorizedWorkspace {
  workspaceId: string
  canonicalRoot: string
  rootDev: number
  rootIno: number
  ownerKind: 'bot' | 'team'
  ownerId: string
  ownerName: string
  canWrite: boolean
  permissionMode: string
  authGeneration: string
}

export class WorkspaceFilesService {
  private readonly db: DatabaseHandle
  private readonly fileLocks = new Map<string, Promise<unknown>>()

  constructor(db: DatabaseHandle) {
    this.db = db
  }

  async resolveContext(rawInput: unknown): Promise<WorkspaceContextResponse> {
    const input = WorkspaceSelectorSchema.parse(rawInput)
    try {
      const auth = await this.authorizeWorkspace(input)
      return {
        authorized: true,
        workspaceId: auth.workspaceId,
        canonicalRoot: auth.canonicalRoot,
        ownerKind: auth.ownerKind,
        ownerId: auth.ownerId,
        ownerName: auth.ownerName,
        canWrite: auth.canWrite,
        permissionMode: auth.permissionMode,
        authGeneration: auth.authGeneration,
        reason: null,
      }
    } catch (err) {
      if (err instanceof DaemonError) {
        return {
          authorized: false,
          workspaceId: null,
          canonicalRoot: null,
          ownerKind: input.teamId ? 'team' : 'bot',
          ownerId: input.teamId ?? input.botId ?? 'unknown',
          ownerName: '',
          canWrite: false,
          permissionMode: 'read-only',
          authGeneration: null,
          reason: err.message,
        }
      }
      throw err
    }
  }

  async listDirectory(rawInput: unknown): Promise<WorkspaceListDirectoryResponse> {
    const input = WorkspaceListDirectoryInputSchema.parse(rawInput)
    const auth = await this.authorizeWorkspace(input)
    if (input.workspaceId !== auth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; refresh workspace context',
        { statusCode: 409 },
      )
    }
    if (input.authGeneration !== auth.authGeneration) {
      throw new DaemonError(
        'STALE_AUTHORIZATION_TOKEN',
        'Workspace authorization generation is stale; refresh workspace context',
        { statusCode: 409 },
      )
    }

    const res = await listContainedDirectory(
      auth.canonicalRoot,
      auth.rootDev,
      auth.rootIno,
      input.relativePath,
    )
    return {
      workspaceId: auth.workspaceId,
      canonicalRoot: auth.canonicalRoot,
      relativePath: res.normalizedRelativePath,
      entries: res.entries,
      truncated: res.truncated,
      totalScanned: res.totalScanned,
    }
  }

  async readFile(rawInput: unknown): Promise<WorkspaceReadFileResponse> {
    const input = WorkspaceReadFileInputSchema.parse(rawInput)
    const auth = await this.authorizeWorkspace(input)
    if (input.workspaceId !== auth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; refresh workspace context',
        { statusCode: 409 },
      )
    }
    if (input.authGeneration !== auth.authGeneration) {
      throw new DaemonError(
        'STALE_AUTHORIZATION_TOKEN',
        'Workspace authorization generation is stale; refresh workspace context',
        { statusCode: 409 },
      )
    }

    const res = await readContainedTextFile(
      auth.canonicalRoot,
      auth.rootDev,
      auth.rootIno,
      input.relativePath,
    )
    return {
      workspaceId: auth.workspaceId,
      relativePath: res.normalizedRelativePath,
      name: res.name,
      content: res.content,
      revision: res.revision,
      sizeBytes: res.sizeBytes,
      readOnly: !auth.canWrite,
      language: detectLanguageFromPath(res.normalizedRelativePath),
    }
  }

  async saveFile(rawInput: unknown, hooks?: SaveHookOptions): Promise<WorkspaceSaveFileResponse> {
    const input = WorkspaceSaveFileInputSchema.parse(rawInput)
    const normalizedPath = normalizeWorkspaceRelativePath(input.relativePath, false).join('/')
    const preAuth = await this.authorizeWorkspace(input)
    if (input.workspaceId !== preAuth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; cannot save to a different workspace',
        { statusCode: 409 },
      )
    }
    if (input.authGeneration !== preAuth.authGeneration) {
      throw new DaemonError(
        'STALE_AUTHORIZATION_TOKEN',
        'Workspace authorization generation is stale; refresh workspace context',
        { statusCode: 409 },
      )
    }

    // Serialize saves by canonical physical file identity (dev:ino + path) across all bots/teams.
    const lockKey = `${preAuth.rootDev}:${preAuth.rootIno}::${normalizedPath}`

    return this.withFileLock(lockKey, async () => {
      const auth = await this.authorizeWorkspace(input)
      if (input.workspaceId !== auth.workspaceId) {
        throw new DaemonError(
          'WORKSPACE_CONTEXT_MISMATCH',
          'Workspace authorization changed; cannot save to a different workspace',
          { statusCode: 409 },
        )
      }
      if (input.authGeneration !== auth.authGeneration) {
        throw new DaemonError(
          'STALE_AUTHORIZATION_TOKEN',
          'Workspace authorization generation is stale; refresh workspace context',
          { statusCode: 409 },
        )
      }
      if (!auth.canWrite) {
        throw new DaemonError(
          'WORKSPACE_READ_ONLY',
          `Saving is blocked because workspace permission mode is '${auth.permissionMode}'`,
          { statusCode: 403 },
        )
      }

      const res = await saveContainedTextFile(
        auth.canonicalRoot,
        auth.rootDev,
        auth.rootIno,
        normalizedPath,
        input.content,
        input.expectedRevision,
        {
          injectWriteError: hooks?.injectWriteError,
          onBeforeCommit: async () => {
            if (hooks?.onBeforeCommit) {
              await hooks.onBeforeCommit()
            }
            // Linearize authorization revalidation right before atomic rename commit.
            const rechecked = await this.authorizeWorkspace(input)
            if (!rechecked.canWrite) {
              throw new DaemonError(
                'WORKSPACE_READ_ONLY',
                `Workspace became read-only ('${rechecked.permissionMode}') during save`,
                { statusCode: 403 },
              )
            }
            if (
              rechecked.workspaceId !== auth.workspaceId ||
              rechecked.authGeneration !== auth.authGeneration
            ) {
              throw new DaemonError(
                'WORKSPACE_CONTEXT_MISMATCH',
                'Workspace authorization changed during save; aborting commit',
                { statusCode: 409 },
              )
            }
          },
        },
      )

      return {
        workspaceId: auth.workspaceId,
        relativePath: res.normalizedRelativePath,
        revision: res.revision,
        sizeBytes: res.sizeBytes,
        savedAt: res.savedAt,
      }
    })
  }

  private async withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tracked = next.then(
      () => undefined,
      () => undefined,
    )
    this.fileLocks.set(key, tracked)
    try {
      return await next
    } finally {
      if (this.fileLocks.get(key) === tracked) {
        this.fileLocks.delete(key)
      }
    }
  }

  private async authorizeWorkspace(selector: {
    botId?: string
    teamId?: string
  }): Promise<AuthorizedWorkspace> {
    await assertDescriptorContainmentSupported()

    let ownerKind: 'bot' | 'team' = 'bot'
    let ownerId = ''
    let ownerName = ''
    let teamUpdatedAt = ''
    let botRow: AgentWorkspaceRow | undefined

    if (selector.teamId) {
      ownerKind = 'team'
      ownerId = selector.teamId
      const teamRow = this.db.sqlite
        .prepare('SELECT id, name, lead_bot_id, updated_at, archived_at FROM teams WHERE id = ?')
        .get(selector.teamId) as TeamWorkspaceRow | undefined
      if (!teamRow || teamRow.archived_at !== null) {
        throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Team is missing or archived', {
          statusCode: 403,
        })
      }
      ownerName = teamRow.name
      teamUpdatedAt = teamRow.updated_at
      botRow = this.db.sqlite
        .prepare(
          'SELECT id, name, workspace_path, permission_mode, updated_at, archived_at FROM agents WHERE id = ?',
        )
        .get(teamRow.lead_bot_id) as AgentWorkspaceRow | undefined
    } else if (selector.botId) {
      ownerKind = 'bot'
      ownerId = selector.botId
      botRow = this.db.sqlite
        .prepare(
          'SELECT id, name, workspace_path, permission_mode, updated_at, archived_at FROM agents WHERE id = ?',
        )
        .get(selector.botId) as AgentWorkspaceRow | undefined
      if (botRow) {
        ownerName = botRow.name
      }
    } else {
      throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Missing bot or team selector', {
        statusCode: 400,
      })
    }

    if (!botRow || botRow.archived_at !== null) {
      throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Bot is missing or archived', {
        statusCode: 403,
      })
    }

    if (botRow.permission_mode === 'full-access') {
      throw new DaemonError(
        'WORKSPACE_UNSUPPORTED_MODE',
        'full-access mode is not authorized for Workspace Panel file operations',
        { statusCode: 403 },
      )
    }

    const rawPath = botRow.workspace_path.trim()
    if (!rawPath || rawPath.includes('\0') || !isAbsolute(rawPath)) {
      throw new DaemonError('WORKSPACE_UNCONFIGURED', 'No authorized workspace root configured', {
        statusCode: 404,
      })
    }

    const resolved = resolve(rawPath)
    const canonicalRoot = await realpath(resolved).catch(() => null)
    if (!canonicalRoot) {
      throw new DaemonError('WORKSPACE_UNAVAILABLE', 'Authorized workspace directory does not exist', {
        statusCode: 404,
      })
    }
    const rootStat = await stat(canonicalRoot).catch(() => null)
    if (!rootStat || !rootStat.isDirectory()) {
      throw new DaemonError('WORKSPACE_UNAVAILABLE', 'Authorized workspace path is not a directory', {
        statusCode: 404,
      })
    }

    const canWrite =
      botRow.permission_mode === 'workspace' || botRow.permission_mode === 'ask-approval'

    const authGeneration = createHash('sha256')
      .update(
        `${ownerKind}:${ownerId}:${botRow.id}:${botRow.permission_mode}:${botRow.updated_at}:${teamUpdatedAt}:${rootStat.dev}:${rootStat.ino}`,
        'utf8',
      )
      .digest('hex')
      .slice(0, 16)

    return {
      workspaceId: computeWorkspaceId(
        canonicalRoot,
        rootStat.dev,
        rootStat.ino,
        ownerKind,
        ownerId,
      ),
      canonicalRoot,
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      ownerKind,
      ownerId,
      ownerName,
      canWrite,
      permissionMode: botRow.permission_mode,
      authGeneration,
    }
  }
}
