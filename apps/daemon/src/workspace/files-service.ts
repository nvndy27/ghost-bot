import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { DatabaseHandle } from '../db/client.ts'
import { DaemonError } from '../errors.ts'
import {
  computeWorkspaceId,
  detectLanguageFromPath,
  listContainedDirectory,
  readContainedTextFile,
  saveContainedTextFile,
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
  archived_at: string | null
}

interface TeamWorkspaceRow {
  id: string
  name: string
  lead_bot_id: string
  archived_at: string | null
}

export interface AuthorizedWorkspace {
  workspaceId: string
  canonicalRoot: string
  ownerKind: 'bot' | 'team'
  ownerId: string
  ownerName: string
  canWrite: boolean
  permissionMode: string
}

export class WorkspaceFilesService {
  private readonly db: DatabaseHandle

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
          reason: err.message,
        }
      }
      throw err
    }
  }

  async listDirectory(rawInput: unknown): Promise<WorkspaceListDirectoryResponse> {
    const input = WorkspaceListDirectoryInputSchema.parse(rawInput)
    const auth = await this.authorizeWorkspace(input)
    if (input.workspaceId && input.workspaceId !== auth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; refresh workspace context',
        { statusCode: 409 },
      )
    }

    const res = await listContainedDirectory(auth.canonicalRoot, input.relativePath)
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
    if (input.workspaceId && input.workspaceId !== auth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; refresh workspace context',
        { statusCode: 409 },
      )
    }

    const res = await readContainedTextFile(auth.canonicalRoot, input.relativePath)
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

  async saveFile(rawInput: unknown): Promise<WorkspaceSaveFileResponse> {
    const input = WorkspaceSaveFileInputSchema.parse(rawInput)
    const auth = await this.authorizeWorkspace(input)
    if (input.workspaceId !== auth.workspaceId) {
      throw new DaemonError(
        'WORKSPACE_CONTEXT_MISMATCH',
        'Workspace authorization changed; cannot save to a different workspace',
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
      input.relativePath,
      input.content,
      input.expectedRevision,
    )

    return {
      workspaceId: auth.workspaceId,
      relativePath: res.normalizedRelativePath,
      revision: res.revision,
      sizeBytes: res.sizeBytes,
      savedAt: res.savedAt,
    }
  }

  private async authorizeWorkspace(selector: {
    botId?: string
    teamId?: string
  }): Promise<AuthorizedWorkspace> {
    let ownerKind: 'bot' | 'team' = 'bot'
    let ownerId = ''
    let ownerName = ''
    let botRow: AgentWorkspaceRow | undefined

    if (selector.teamId) {
      ownerKind = 'team'
      ownerId = selector.teamId
      const teamRow = this.db.sqlite
        .prepare('SELECT id, name, lead_bot_id, archived_at FROM teams WHERE id = ?')
        .get(selector.teamId) as TeamWorkspaceRow | undefined
      if (!teamRow || teamRow.archived_at !== null) {
        throw new DaemonError('WORKSPACE_UNAUTHORIZED', 'Team is missing or archived', {
          statusCode: 403,
        })
      }
      ownerName = teamRow.name
      botRow = this.db.sqlite
        .prepare('SELECT id, name, workspace_path, permission_mode, archived_at FROM agents WHERE id = ?')
        .get(teamRow.lead_bot_id) as AgentWorkspaceRow | undefined
    } else if (selector.botId) {
      ownerKind = 'bot'
      ownerId = selector.botId
      botRow = this.db.sqlite
        .prepare('SELECT id, name, workspace_path, permission_mode, archived_at FROM agents WHERE id = ?')
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

    return {
      workspaceId: computeWorkspaceId(canonicalRoot),
      canonicalRoot,
      ownerKind,
      ownerId,
      ownerName,
      canWrite,
      permissionMode: botRow.permission_mode,
    }
  }
}
