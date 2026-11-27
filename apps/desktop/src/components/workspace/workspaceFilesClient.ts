export interface WorkspaceContextInfo {
  authorized: boolean
  workspaceId: string | null
  canonicalRoot: string | null
  ownerKind: 'bot' | 'team'
  ownerId: string
  ownerName: string
  canWrite: boolean
  permissionMode: string
  authGeneration: string | null
  reason: string | null
}

export interface WorkspaceDirectoryEntryItem {
  name: string
  relativePath: string
  kind: 'directory' | 'file'
  sizeBytes: number | null
  sensitive?: boolean
}

export interface WorkspaceListDirectoryResult {
  workspaceId: string
  canonicalRoot: string
  relativePath: string
  entries: WorkspaceDirectoryEntryItem[]
  truncated: boolean
  totalScanned: number
}

export interface WorkspaceReadFileResult {
  workspaceId: string
  relativePath: string
  name: string
  content: string
  revision: string
  sizeBytes: number
  readOnly: boolean
  language: string
}

export interface WorkspaceSaveFileResult {
  workspaceId: string
  relativePath: string
  revision: string
  sizeBytes: number
  savedAt: string
}

export interface WorkspaceSelector {
  botId?: string
  teamId?: string
}

export interface WorkspaceFilesTransport {
  resolveContext: (selector: WorkspaceSelector) => Promise<WorkspaceContextInfo>
  listDirectory: (
    params: WorkspaceSelector & {
      workspaceId: string
      authGeneration: string
      relativePath: string
    },
  ) => Promise<WorkspaceListDirectoryResult>
  readFile: (
    params: WorkspaceSelector & {
      workspaceId: string
      authGeneration: string
      relativePath: string
    },
  ) => Promise<WorkspaceReadFileResult>
  saveFile: (
    params: WorkspaceSelector & {
      workspaceId: string
      authGeneration: string
      relativePath: string
      content: string
      expectedRevision: string
    },
  ) => Promise<WorkspaceSaveFileResult>
}

interface CoordinatedGhostBotWorkspaceBridge {
  resolveWorkspaceContext?: WorkspaceFilesTransport['resolveContext']
  listWorkspaceDirectory?: WorkspaceFilesTransport['listDirectory']
  readWorkspaceFile?: WorkspaceFilesTransport['readFile']
  saveWorkspaceFile?: WorkspaceFilesTransport['saveFile']
}

export function getDefaultWorkspaceFilesTransport(): WorkspaceFilesTransport | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as { ghostBot?: CoordinatedGhostBotWorkspaceBridge }).ghostBot
  if (
    !bridge ||
    typeof bridge.resolveWorkspaceContext !== 'function' ||
    typeof bridge.listWorkspaceDirectory !== 'function' ||
    typeof bridge.readWorkspaceFile !== 'function' ||
    typeof bridge.saveWorkspaceFile !== 'function'
  ) {
    return null
  }
  return {
    resolveContext: bridge.resolveWorkspaceContext.bind(bridge),
    listDirectory: bridge.listWorkspaceDirectory.bind(bridge),
    readFile: bridge.readWorkspaceFile.bind(bridge),
    saveFile: bridge.saveWorkspaceFile.bind(bridge),
  }
}
