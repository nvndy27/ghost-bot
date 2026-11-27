export interface PersonalWorkspaceAccess {
  botId: string
  workspaceId: string
  authGeneration: string
}

export interface WorkspaceSearchHit {
  relativePath: string
  lineNumber: number | null
  line: string | null
}

export type WorkspacePreviewPayload =
  | { kind: 'markdown' | 'svg'; text: string }
  | { kind: 'image'; mime: 'image/png' | 'image/gif'; base64: string }
  | { kind: 'pdf'; page: number; pageCount: number; base64: string }
  | { kind: 'unavailable'; reason: string }

type DiscoveryOperation = PersonalWorkspaceAccess & { operationId: string }

export interface WorkspaceDiscoveryTransport {
  searchWorkspaceFiles(input: DiscoveryOperation & { mode: 'filename' | 'content'; query: string }): Promise<{
    workspaceId: string
    authGeneration: string
    operationId: string
    results: WorkspaceSearchHit[]
    truncated: boolean
    scannedFiles: number
  }>
  cancelWorkspaceDiscovery(input: DiscoveryOperation): Promise<boolean>
  previewWorkspaceFile(input: DiscoveryOperation & { relativePath: string; page: number }): Promise<{
    operationId: string
    workspaceId: string
    authGeneration: string
    relativePath: string
    preview: WorkspacePreviewPayload
  }>
}

export type WorkspaceDraftSelection = PersonalWorkspaceAccess & { relativePath: string; text: string }

export function getWorkspaceDiscoveryTransport(): WorkspaceDiscoveryTransport | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as { ghostBot?: Partial<WorkspaceDiscoveryTransport> }).ghostBot
  if (
    typeof bridge?.searchWorkspaceFiles !== 'function' ||
    typeof bridge.cancelWorkspaceDiscovery !== 'function' ||
    typeof bridge.previewWorkspaceFile !== 'function'
  ) return null
  return {
    searchWorkspaceFiles: bridge.searchWorkspaceFiles.bind(bridge),
    cancelWorkspaceDiscovery: bridge.cancelWorkspaceDiscovery.bind(bridge),
    previewWorkspaceFile: bridge.previewWorkspaceFile.bind(bridge),
  }
}
