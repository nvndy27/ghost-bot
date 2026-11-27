import type { z } from 'zod'
import { DaemonError } from '../errors.ts'
import {
  WorkspaceDiscoveryOperationSchema,
  WorkspacePreviewInputSchema,
  WorkspaceSearchInputSchema,
  type PersonalWorkspaceAccessSchema,
} from './discovery-contracts.ts'
import type { WorkspaceFilesService } from './files-service.ts'

type Access = z.infer<typeof PersonalWorkspaceAccessSchema>
type Operation = z.infer<typeof WorkspaceDiscoveryOperationSchema>
type RequireNativeGrant = (access: Access) => void | Promise<void>

function operationKey(input: Operation): string {
  return JSON.stringify([input.botId, input.workspaceId, input.authGeneration, input.operationId])
}

/** Shared routes supply the transport-owned native grant check. No discovery routes are registered here. */
export class WorkspaceDiscoveryOperations {
  private readonly active = new Map<string, { botId: string; controller: AbortController }>()

  private readonly files: Pick<WorkspaceFilesService, 'searchFiles' | 'previewFile'>
  private readonly requireNativeGrant: RequireNativeGrant

  constructor(files: Pick<WorkspaceFilesService, 'searchFiles' | 'previewFile'>, requireNativeGrant: RequireNativeGrant) {
    this.files = files
    this.requireNativeGrant = requireNativeGrant
  }

  search(rawInput: unknown, caller?: AbortSignal) {
    const input = WorkspaceSearchInputSchema.parse(rawInput)
    return this.run(input, (signal) => this.files.searchFiles(input, signal), caller)
  }

  preview(rawInput: unknown, caller?: AbortSignal) {
    const input = WorkspacePreviewInputSchema.parse(rawInput)
    return this.run(input, (signal) => this.files.previewFile(input, signal), caller)
  }

  async cancel(rawInput: unknown): Promise<boolean> {
    const input = WorkspaceDiscoveryOperationSchema.parse(rawInput)
    await this.requireNativeGrant(input)
    const controller = this.active.get(operationKey(input))?.controller
    if (!controller || controller.signal.aborted) return false
    controller.abort()
    return true
  }

  abortAll(): void {
    for (const { controller } of this.active.values()) controller.abort()
  }

  abortForBot(botId: string): void {
    for (const operation of this.active.values()) {
      if (operation.botId === botId) operation.controller.abort()
    }
  }

  private async run<T>(input: Operation, perform: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    caller?.throwIfAborted()
    const key = operationKey(input)
    if (this.active.has(key)) {
      throw new DaemonError('DISCOVERY_DUPLICATE', 'Workspace operation is already active', { statusCode: 409 })
    }
    if (this.active.size >= 8) {
      throw new DaemonError('DISCOVERY_BUSY', 'Too many active workspace operations', { statusCode: 429 })
    }
    const controller = new AbortController()
    const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal
    this.active.set(key, { botId: input.botId, controller })
    try {
      await this.requireNativeGrant(input)
      signal.throwIfAborted()
      const result = await perform(signal)
      await this.requireNativeGrant(input)
      signal.throwIfAborted()
      return result
    } finally {
      this.active.delete(key)
    }
  }
}
