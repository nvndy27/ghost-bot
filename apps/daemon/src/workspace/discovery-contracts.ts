import { z } from 'zod'

export const DISCOVERY_LIMITS = {
  maxDepth: 8,
  maxDirectories: 96,
  maxEntries: 4000,
  maxFiles: 600,
  maxResults: 100,
  maxLineLength: 320,
  maxTextBytes: 64 * 1024,
  maxPreviewBytes: 1024 * 1024,
  maxSearchMs: 2500,
} as const

export const PersonalWorkspaceAccessSchema = z.object({
  botId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  workspaceId: z.string().min(1).max(128),
  authGeneration: z.string().min(1).max(64),
}).strict()

export const WorkspaceSearchOperationSchema = PersonalWorkspaceAccessSchema.extend({
  operationId: z.uuid(),
})

export const WorkspaceSearchInputSchema = WorkspaceSearchOperationSchema.extend({
  query: z.string().trim().min(1).max(128).regex(/^[^\r\n\0]+$/),
  mode: z.enum(['filename', 'content']),
})

export const WorkspacePreviewInputSchema = PersonalWorkspaceAccessSchema.extend({
  relativePath: z.string().min(1).max(512),
})

export interface WorkspaceSearchHit {
  relativePath: string
  lineNumber: number | null
  line: string | null
}

export interface WorkspaceSearchResult {
  workspaceId: string
  authGeneration: string
  operationId: string
  results: WorkspaceSearchHit[]
  truncated: boolean
  scannedFiles: number
}

export type WorkspacePreviewPayload =
  | { kind: 'markdown' | 'svg'; text: string }
  | { kind: 'image'; mime: 'image/png' | 'image/gif'; base64: string }
  | { kind: 'unavailable'; reason: string }

export interface WorkspacePreviewResult {
  workspaceId: string
  authGeneration: string
  relativePath: string
  preview: WorkspacePreviewPayload
}
