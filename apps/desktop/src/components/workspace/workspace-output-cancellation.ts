import type {
  WorkspaceOutputCancelInput,
  WorkspaceOutputEntry,
} from '@ghost-bot/shared-types/ipc'

export type WorkspaceOutputContextKind = 'bot' | 'team'

function isCommandEntry(entry: WorkspaceOutputEntry): boolean {
  return entry.source === 'terminal' || entry.source === 'build'
}

export function cancellationTargetKey(entry: WorkspaceOutputEntry): string | null {
  if (!isCommandEntry(entry)) return `run:${entry.runId}`
  if (typeof entry.taskId !== 'string' || entry.taskId.trim().length === 0) return null
  return `command:${entry.runId}:${entry.taskId}`
}

export function selectCancellationActionEntries(
  entries: WorkspaceOutputEntry[],
  contextKind: WorkspaceOutputContextKind,
): Map<string, string> {
  const actions = new Map<string, string>()
  if (contextKind !== 'bot') return actions

  for (const entry of entries) {
    const key = cancellationTargetKey(entry)
    if (
      entry.cancellable &&
      key !== null &&
      entry.id === `run-summary:${entry.runId}`
    ) {
      actions.set(key, entry.id)
    }
  }

  for (const entry of entries) {
    const key = cancellationTargetKey(entry)
    if (entry.cancellable && key !== null && !actions.has(key)) {
      actions.set(key, entry.id)
    }
  }

  return actions
}

export function createWorkspaceOutputCancelInput(
  entry: WorkspaceOutputEntry,
  contextKind: WorkspaceOutputContextKind,
  botId: string | null,
): WorkspaceOutputCancelInput | null {
  if (contextKind !== 'bot' || !botId || !entry.cancellable) return null

  if (isCommandEntry(entry)) {
    if (typeof entry.taskId !== 'string' || entry.taskId.trim().length === 0) return null
    return {
      botId,
      runId: entry.runId,
      sessionId: entry.sessionId ?? undefined,
      terminalCommandId: entry.taskId,
    }
  }

  return {
    botId,
    runId: entry.runId,
    sessionId: entry.sessionId ?? undefined,
  }
}
