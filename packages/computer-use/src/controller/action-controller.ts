import {
  ComputerUseError,
  type ActionBatch,
  type ActionResult,
  type BatchExecutionResult,
  type CaptureRequest,
  type ComputerUseAction,
  type ComputerUseBackend,
  type ComputerUseCapability,
  type ObservationResult,
  type ScreenshotMetadata,
} from '../contracts/types.ts'
import type { ComputerUseAuditLog } from '../audit/audit-log.ts'
import type { ComputerUseSessionManager } from '../session/session-state-machine.ts'
import { validateActionBatch } from '../validation/actions.ts'

function actionToCapability(action: ComputerUseAction): {
  category: 'pointer' | 'keyboard' | 'wait'
  capability: ComputerUseCapability
} {
  if (action.kind === 'wait') {
    return { category: 'wait', capability: 'discovery' }
  }
  if (
    action.kind === 'move' ||
    action.kind === 'click' ||
    action.kind === 'double_click' ||
    action.kind === 'drag' ||
    action.kind === 'scroll'
  ) {
    return { category: 'pointer', capability: 'pointer_control' }
  }
  return { category: 'keyboard', capability: 'keyboard_control' }
}

/**
 * Narrow action execution controller enforcing session scope, capability consent,
 * display topology freshness, bounded batches, duplicate prevention, and fail-closed
 * stop on uncertain outcomes or emergency stop.
 */
export class ComputerUseActionController {
  private readonly backend: ComputerUseBackend
  private readonly sessions: ComputerUseSessionManager
  private readonly audit: ComputerUseAuditLog
  private readonly observationsById = new Map<string, ScreenshotMetadata>()
  private readonly seenActionIdsBySession = new Map<string, Set<string>>()
  private readonly cancelledBatches = new Set<string>()

  constructor(
    backend: ComputerUseBackend,
    sessions: ComputerUseSessionManager,
    audit: ComputerUseAuditLog,
  ) {
    this.backend = backend
    this.sessions = sessions
    this.audit = audit
  }

  cancelBatch(batchId: string): void {
    this.cancelledBatches.add(batchId)
  }

  async captureScreen(req: CaptureRequest, nowMs = Date.now()): Promise<ObservationResult> {
    const caps = await this.backend.getCapabilities()
    if (!caps.observeScreen) {
      throw new ComputerUseError('UNSUPPORTED_CAPABILITY', 'Screen observation is unsupported')
    }

    this.sessions.assertAuthorizedFor(
      req.sessionId,
      req.ownerId,
      req.botId,
      'observe_screen',
      req.displayId,
      nowMs,
    )

    try {
      const obs = await this.backend.captureScreen({
        sessionId: req.sessionId,
        displayId: req.displayId,
        region: req.region,
        includeCursor: req.includeCursor,
      })
      this.observationsById.set(obs.metadata.observationId, obs.metadata)
      this.audit.record(
        {
          sessionId: req.sessionId,
          ownerId: req.ownerId,
          botId: req.botId,
          actionId: obs.metadata.observationId,
          category: 'observe',
          capability: 'observe_screen',
          outcome: 'completed',
          isSimulation: obs.metadata.isSimulation,
        },
        nowMs,
      )
      return obs
    } catch (err) {
      this.audit.record(
        {
          sessionId: req.sessionId,
          ownerId: req.ownerId,
          botId: req.botId,
          actionId: `obs_fail_${req.displayId}`,
          category: 'observe',
          capability: 'observe_screen',
          outcome: 'failed',
          error: err instanceof Error ? err.message : 'Capture failed',
          isSimulation: caps.isSimulation,
        },
        nowMs,
      )
      throw err
    }
  }

  async executeBatch(batch: ActionBatch, nowMs = Date.now()): Promise<BatchExecutionResult> {
    const caps = await this.backend.getCapabilities()
    const displays = await this.backend.listDisplays()

    // Validate batch structure, bounds, coordinates, and observation freshness before starting
    validateActionBatch(batch, displays, this.observationsById)

    let sessionSeen = this.seenActionIdsBySession.get(batch.sessionId)
    if (!sessionSeen) {
      sessionSeen = new Set<string>()
      this.seenActionIdsBySession.set(batch.sessionId, sessionSeen)
    }
    for (const action of batch.actions) {
      if (sessionSeen.has(action.actionId)) {
        throw new ComputerUseError(
          'DUPLICATE_ACTION',
          `Action "${action.actionId}" was already submitted in session "${batch.sessionId}" (no automatic replay)`,
        )
      }
    }

    const results: ActionResult[] = []
    let halted = false
    let haltReason: string | null = null

    for (let i = 0; i < batch.actions.length; i += 1) {
      const action = batch.actions[i]!
      const { category, capability } = actionToCapability(action)

      if (this.cancelledBatches.has(batch.batchId)) {
        halted = true
        haltReason = 'Batch cancelled'
        results.push({
          actionId: action.actionId,
          category,
          capability,
          status: 'cancelled',
          startedAt: null,
          endedAt: new Date(nowMs).toISOString(),
          durationMs: 0,
          uncertain: false,
          replayAllowed: false,
          errorCode: 'BATCH_CANCELLED',
          errorMessage: 'Batch cancelled before action dispatch',
          isSimulation: caps.isSimulation,
        })
        this.audit.record(
          {
            sessionId: batch.sessionId,
            ownerId: batch.ownerId,
            botId: batch.botId,
            actionId: action.actionId,
            category,
            capability,
            outcome: 'cancelled',
            isSimulation: caps.isSimulation,
          },
          nowMs,
        )
        continue
      }

      // Re-check session authorization, capability, and display scope before every action
      try {
        const displayId = action.kind === 'wait' ? undefined : action.displayId
        this.sessions.assertAuthorizedFor(
          batch.sessionId,
          batch.ownerId,
          batch.botId,
          capability,
          displayId,
          nowMs,
        )
      } catch (err) {
        halted = true
        haltReason = err instanceof Error ? err.message : 'Authorization lost'
        const code = err instanceof ComputerUseError ? err.code : 'CONSENT_REVOKED'
        results.push({
          actionId: action.actionId,
          category,
          capability,
          status: 'cancelled',
          startedAt: null,
          endedAt: new Date(nowMs).toISOString(),
          durationMs: 0,
          uncertain: false,
          replayAllowed: false,
          errorCode: code,
          errorMessage: haltReason,
          isSimulation: caps.isSimulation,
        })
        this.audit.record(
          {
            sessionId: batch.sessionId,
            ownerId: batch.ownerId,
            botId: batch.botId,
            actionId: action.actionId,
            category,
            capability,
            outcome: 'denied',
            error: haltReason,
            isSimulation: caps.isSimulation,
          },
          nowMs,
        )
        // Cancel remaining actions without executing
        for (let j = i + 1; j < batch.actions.length; j += 1) {
          const rem = batch.actions[j]!
          const remMeta = actionToCapability(rem)
          results.push({
            actionId: rem.actionId,
            category: remMeta.category,
            capability: remMeta.capability,
            status: 'cancelled',
            startedAt: null,
            endedAt: new Date(nowMs).toISOString(),
            durationMs: 0,
            uncertain: false,
            replayAllowed: false,
            errorCode: code,
            errorMessage: 'Cancelled after authorization halt',
            isSimulation: caps.isSimulation,
          })
        }
        break
      }

      sessionSeen.add(action.actionId)
      const startedAt = new Date(nowMs).toISOString()

      try {
        const outcome =
          category === 'pointer'
            ? await this.backend.executePointerAction({
                sessionId: batch.sessionId,
                action: action as Extract<ComputerUseAction, { coordinateSpace: unknown }>,
              })
            : await this.backend.executeKeyboardAction({
                sessionId: batch.sessionId,
                action: action as Exclude<ComputerUseAction, { coordinateSpace: unknown }>,
              })

        const endedAt = new Date(nowMs).toISOString()
        if (outcome.ok) {
          results.push({
            actionId: action.actionId,
            category,
            capability,
            status: 'completed',
            startedAt,
            endedAt,
            durationMs: outcome.durationMs,
            uncertain: false,
            replayAllowed: false,
            errorCode: null,
            errorMessage: null,
            isSimulation: caps.isSimulation,
          })
          this.audit.record(
            {
              sessionId: batch.sessionId,
              ownerId: batch.ownerId,
              botId: batch.botId,
              actionId: action.actionId,
              category,
              capability,
              outcome: 'completed',
              isSimulation: caps.isSimulation,
            },
            nowMs,
          )
        } else {
          const isUncertain = Boolean(outcome.uncertain)
          results.push({
            actionId: action.actionId,
            category,
            capability,
            status: isUncertain ? 'uncertain' : 'failed',
            startedAt,
            endedAt,
            durationMs: 0,
            uncertain: isUncertain,
            replayAllowed: false,
            errorCode: outcome.code,
            errorMessage: outcome.message,
            isSimulation: caps.isSimulation,
          })
          this.audit.record(
            {
              sessionId: batch.sessionId,
              ownerId: batch.ownerId,
              botId: batch.botId,
              actionId: action.actionId,
              category,
              capability,
              outcome: isUncertain ? 'uncertain' : 'failed',
              error: outcome.message,
              isSimulation: caps.isSimulation,
            },
            nowMs,
          )
          // Halt remaining actions on uncertain outcome or failure
          halted = true
          haltReason = outcome.message
          for (let j = i + 1; j < batch.actions.length; j += 1) {
            const rem = batch.actions[j]!
            const remMeta = actionToCapability(rem)
            results.push({
              actionId: rem.actionId,
              category: remMeta.category,
              capability: remMeta.capability,
              status: 'cancelled',
              startedAt: null,
              endedAt,
              durationMs: 0,
              uncertain: false,
              replayAllowed: false,
              errorCode: isUncertain ? 'EXECUTION_UNCERTAIN' : 'PRIOR_ACTION_FAILED',
              errorMessage: 'Halted after prior action did not complete',
              isSimulation: caps.isSimulation,
            })
          }
          break
        }
      } catch (err) {
        // Backend threw/disconnected mid-action: outcome is UNCERTAIN and must NOT be replayed
        const endedAt = new Date(nowMs).toISOString()
        const msg = err instanceof Error ? err.message : 'Backend threw during execution'
        results.push({
          actionId: action.actionId,
          category,
          capability,
          status: 'uncertain',
          startedAt,
          endedAt,
          durationMs: 0,
          uncertain: true,
          replayAllowed: false,
          errorCode: err instanceof ComputerUseError ? err.code : 'EXECUTION_UNCERTAIN',
          errorMessage: msg,
          isSimulation: caps.isSimulation,
        })
        this.audit.record(
          {
            sessionId: batch.sessionId,
            ownerId: batch.ownerId,
            botId: batch.botId,
            actionId: action.actionId,
            category,
            capability,
            outcome: 'uncertain',
            error: msg,
            isSimulation: caps.isSimulation,
          },
          nowMs,
        )
        halted = true
        haltReason = msg
        for (let j = i + 1; j < batch.actions.length; j += 1) {
          const rem = batch.actions[j]!
          const remMeta = actionToCapability(rem)
          results.push({
            actionId: rem.actionId,
            category: remMeta.category,
            capability: remMeta.capability,
            status: 'cancelled',
            startedAt: null,
            endedAt,
            durationMs: 0,
            uncertain: false,
            replayAllowed: false,
            errorCode: 'EXECUTION_UNCERTAIN',
            errorMessage: 'Halted after uncertain action outcome',
            isSimulation: caps.isSimulation,
          })
        }
        break
      }
    }

    return {
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      halted,
      haltReason,
      results,
    }
  }
}
