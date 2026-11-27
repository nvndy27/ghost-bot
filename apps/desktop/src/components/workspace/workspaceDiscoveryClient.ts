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
  | { kind: 'unavailable'; reason: string }

type SearchOperation = PersonalWorkspaceAccess & { operationId: string }

export interface WorkspaceDiscoveryTransport {
  searchWorkspaceFiles(input: SearchOperation & { mode: 'filename' | 'content'; query: string }): Promise<{
    workspaceId: string
    authGeneration: string
    operationId: string
    results: WorkspaceSearchHit[]
    truncated: boolean
    scannedFiles: number
  }>
  cancelWorkspaceSearch(input: SearchOperation): Promise<boolean>
  previewWorkspaceFile(input: PersonalWorkspaceAccess & { relativePath: string }): Promise<{
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
    typeof bridge.cancelWorkspaceSearch !== 'function' ||
    typeof bridge.previewWorkspaceFile !== 'function'
  ) return null
  return {
    searchWorkspaceFiles: bridge.searchWorkspaceFiles.bind(bridge),
    cancelWorkspaceSearch: bridge.cancelWorkspaceSearch.bind(bridge),
    previewWorkspaceFile: bridge.previewWorkspaceFile.bind(bridge),
  }
}
