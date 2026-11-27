import { z } from 'zod'

export const WorkspaceGitOperationSchema = z.object({
  botId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  workspaceId: z.string().min(1).max(128),
  authGeneration: z.string().min(1).max(64),
  operationId: z.uuid(),
}).strict()

const path = z.string().min(1).max(512)
const commitId = z.string().regex(/^[a-f0-9]{40}$/)
export const WorkspaceGitInspectSchema = z.discriminatedUnion('kind', [
  WorkspaceGitOperationSchema.extend({ kind: z.literal('status') }),
  WorkspaceGitOperationSchema.extend({
    kind: z.literal('diff'),
    relativePath: path,
    layer: z.enum(['staged', 'unstaged', 'untracked']),
  }),
  WorkspaceGitOperationSchema.extend({ kind: z.literal('commit'), commitId }),
])

const commit = z.object({
  id: commitId,
  author: z.string().max(256),
  date: z.string().max(64),
  subject: z.string().max(512),
})
const change = z.object({ path, code: z.string().max(2) })

export const WorkspaceGitResponseSchema = WorkspaceGitOperationSchema.extend({
  result: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('unavailable'), reason: z.string().max(300) }),
    z.object({
      kind: z.literal('status'),
      branch: z.string().max(512).nullable(),
      head: commitId.nullable(),
      staged: z.array(change).max(500),
      unstaged: z.array(change).max(500),
      untracked: z.array(change).max(500),
      history: z.array(commit).max(25),
      truncated: z.boolean(),
    }),
    z.object({
      kind: z.literal('diff'),
      path,
      patch: z.string().max(131072),
      truncated: z.boolean(),
    }),
    z.object({
      kind: z.literal('commit'),
      commit,
      message: z.string().max(8192),
      files: z.array(change).max(500),
      truncated: z.boolean(),
    }),
  ]),
})

export type WorkspaceGitOperation = z.infer<typeof WorkspaceGitOperationSchema>
export type WorkspaceGitInspect = z.infer<typeof WorkspaceGitInspectSchema>
export type WorkspaceGitResponse = z.infer<typeof WorkspaceGitResponseSchema>
