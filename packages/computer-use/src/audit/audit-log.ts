import { randomUUID } from 'node:crypto'
import type {
  ActionAuditEvent,
  ActionOutcomeStatus,
  ComputerUseCapability,
} from '../contracts/types.ts'

export function redactAuditError(input: string | null | undefined): string | null {
  if (!input) return null
  return input
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret|apiKey|api_key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .slice(0, 512)
}

export class ComputerUseAuditLog {
  private readonly maxEvents: number
  private readonly events: ActionAuditEvent[] = []

  constructor(maxEvents = 500) {
    this.maxEvents = Math.max(10, maxEvents)
  }

  record(
    input: {
      sessionId: string
      ownerId: string
      botId: string
      actionId: string
      category: ActionAuditEvent['category']
      capability: ComputerUseCapability
      outcome: ActionOutcomeStatus | 'denied' | 'revoked' | 'emergency_stop'
      error?: string | null
      isSimulation: boolean
    },
    nowMs = Date.now(),
  ): ActionAuditEvent {
    // Never store raw screenshot bytes, typed text, clipboard contents, or credentials.
    const event: ActionAuditEvent = {
      eventId: `cu_evt_${randomUUID()}`,
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      botId: input.botId,
      actionId: input.actionId,
      category: input.category,
      capability: input.capability,
      timestamp: new Date(nowMs).toISOString(),
      outcome: input.outcome,
      sanitizedError: redactAuditError(input.error),
      isSimulation: input.isSimulation,
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    return structuredClone(event)
  }

  listBySession(sessionId: string, ownerId: string): ActionAuditEvent[] {
    return this.events
      .filter((e) => e.sessionId === sessionId && e.ownerId === ownerId)
      .map((e) => structuredClone(e))
  }

  count(): number {
    return this.events.length
  }
}
