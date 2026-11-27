import { z } from 'zod'

const tabId = z.uuid()
export const WorkspaceBrowserBoundsSchema = z.object({
  x: z.number().int().min(0).max(8000),
  y: z.number().int().min(0).max(8000),
  width: z.number().int().min(1).max(1600),
  height: z.number().int().min(1).max(1200),
}).strict().nullable()

export const WorkspaceBrowserCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state') }).strict(),
  z.object({ kind: z.literal('new') }).strict(),
  z.object({ kind: z.literal('close-all') }).strict(),
  z.object({ kind: z.enum(['select', 'close', 'back', 'forward', 'reload', 'stop']), tabId }).strict(),
  z.object({ kind: z.literal('navigate'), tabId, url: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal('viewport'), tabId, preset: z.enum(['desktop', 'mobile']) }).strict(),
])

export const WorkspaceBrowserStateSchema = z.object({
  active: tabId.nullable(),
  tabs: z.array(z.object({
    id: tabId,
    url: z.string().max(2048),
    title: z.string().max(120),
    loading: z.boolean(),
    error: z.string().max(300).nullable(),
    back: z.boolean(),
    forward: z.boolean(),
    preset: z.enum(['desktop', 'mobile']),
    console: z.array(z.object({ level: z.string().max(10), time: z.number() })).max(40),
  })).max(4),
})

export type WorkspaceBrowserCommand = z.infer<typeof WorkspaceBrowserCommandSchema>
export type WorkspaceBrowserBounds = z.infer<typeof WorkspaceBrowserBoundsSchema>
export type WorkspaceBrowserState = z.infer<typeof WorkspaceBrowserStateSchema>
