import { DaemonError } from '../errors.ts'

export const RUN_STATUSES = [
  'queued',
  'starting',
  'running',
  'awaiting_approval',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
] as const

export type RunStatus = (typeof RUN_STATUSES)[number]

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'cancelled',
  'failed',
  'interrupted',
])

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'starting',
  'running',
  'awaiting_approval',
  'cancelling',
]

const ALLOWED_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['starting', 'cancelling', 'failed', 'interrupted'],
  starting: ['running', 'cancelling', 'failed', 'interrupted'],
  running: ['awaiting_approval', 'cancelling', 'completed', 'failed', 'interrupted'],
  awaiting_approval: ['running', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed', 'interrupted'],
  completed: [],
  cancelled: [],
  failed: [],
  interrupted: [],
}

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value)
}

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function assertLegalTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransition(from, to)) {
    throw new DaemonError(
      'INVALID_RUN_TRANSITION',
      `Illegal run state transition from "${from}" to "${to}"`,
      { statusCode: 409 },
    )
  }
}

export function resolveTerminalRace(
  current: RunStatus,
  incoming: RunStatus,
): 'ignore_duplicate' | 'reject_conflict' | 'proceed' {
  if (!isTerminalStatus(current)) {
    return 'proceed'
  }
  if (current === incoming) {
    return 'ignore_duplicate'
  }
  return 'reject_conflict'
}
