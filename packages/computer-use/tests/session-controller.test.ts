import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ComputerUseAuditLog } from '../src/audit/audit-log.ts'
import {
  createDefaultSimulatedDisplays,
  SimulatedComputerUseBackend,
} from '../src/backends/simulated-backend.ts'
import { ComputerUseActionController } from '../src/controller/action-controller.ts'
import { ComputerUseError } from '../src/contracts/types.ts'
import { ComputerUseSessionManager } from '../src/session/session-state-machine.ts'

describe('ComputerUseSessionManager & ActionController', () => {
  it('enforces capability-specific consent, owner/bot scope isolation, and display scope on topology changes', async () => {
    const backend = new SimulatedComputerUseBackend()
    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const controller = new ComputerUseActionController(backend, sessions, audit)

    const caps = await backend.getCapabilities()
    assert.equal(caps.isSimulation, true)
    assert.equal(caps.nativeWaylandVerified, false)

    const displays = await backend.listDisplays()
    const sess = sessions.createSession({
      ownerId: 'owner-1',
      botId: 'bot-1',
      topologyVersion: displays[0]!.topologyVersion,
    })

    // Request only observe_screen on sim-disp-1 (NOT pointer_control)
    sessions.requestConsent(sess.id, 'owner-1', caps, ['observe_screen'])
    const consent = await backend.requestConsent({
      sessionId: sess.id,
      requestedCapabilities: ['observe_screen'],
      requestedDisplayIds: ['sim-disp-1'],
    })
    assert.equal(consent.isSimulated, true)
    sessions.applyConsent(sess.id, 'owner-1', consent, 1)
    sessions.activate(sess.id, 'owner-1')

    // Capture succeeds on sim-disp-1 and is labeled simulation
    const obs = await controller.captureScreen({
      sessionId: sess.id,
      ownerId: 'owner-1',
      botId: 'bot-1',
      displayId: 'sim-disp-1',
    })
    assert.equal(obs.metadata.isSimulation, true)

    // Cross-owner or cross-bot capture is denied
    await assert.rejects(
      () =>
        controller.captureScreen({
          sessionId: sess.id,
          ownerId: 'owner-2',
          botId: 'bot-1',
          displayId: 'sim-disp-1',
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'SCOPE_FORBIDDEN',
    )

    // Newly connected display sim-disp-3 is not auto-granted
    backend.updateDisplays([
      ...displays,
      {
        displayId: 'sim-disp-3',
        name: 'Hotplugged',
        originX: 1920,
        originY: 0,
        logicalWidth: 1920,
        logicalHeight: 1080,
        physicalWidth: 1920,
        physicalHeight: 1080,
        scaleFactor: 1,
        isPrimary: false,
        topologyVersion: 2,
      },
    ])
    await assert.rejects(
      () =>
        controller.captureScreen({
          sessionId: sess.id,
          ownerId: 'owner-1',
          botId: 'bot-1',
          displayId: 'sim-disp-3',
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'SCOPE_FORBIDDEN',
    )

    // observe_screen consent does NOT grant pointer_control
    const batchRes = await controller.executeBatch({
      batchId: 'b-denied',
      sessionId: sess.id,
      ownerId: 'owner-1',
      botId: 'bot-1',
      actions: [
        {
          actionId: 'click-1',
          kind: 'click',
          displayId: 'sim-disp-1',
          x: 10,
          y: 10,
          coordinateSpace: 'logical',
          description: 'Please allow this click',
        },
      ],
    })
    assert.equal(batchRes.halted, true)
    assert.equal(batchRes.results[0]?.status, 'cancelled')
    assert.equal(batchRes.results[0]?.errorCode, 'CONSENT_REQUIRED')
  })

  it('rejects unsupported capabilities, expiration, revocation, and emergency stop', async () => {
    const noKeyboardBackend = new SimulatedComputerUseBackend({
      capabilities: { keyboardControl: false },
    })
    const sessions = new ComputerUseSessionManager()
    const caps = await noKeyboardBackend.getCapabilities()
    const sess = sessions.createSession(
      { ownerId: 'o1', botId: 'b1', topologyVersion: 1, ttlMs: 100 },
      1000,
    )

    assert.throws(
      () => sessions.requestConsent(sess.id, 'o1', caps, ['keyboard_control'], 1000),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'UNSUPPORTED_CAPABILITY',
    )

    sessions.requestConsent(sess.id, 'o1', caps, ['observe_screen'], 1000)
    const consent = await noKeyboardBackend.requestConsent({
      sessionId: sess.id,
      requestedCapabilities: ['observe_screen'],
      requestedDisplayIds: ['sim-disp-1'],
    })
    sessions.applyConsent(sess.id, 'o1', consent, 1, 1000)

    // Expiration
    assert.throws(
      () => sessions.activate(sess.id, 'o1', 2000),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'SESSION_EXPIRED',
    )

    // Emergency stop
    const sess2 = sessions.createSession({ ownerId: 'o1', botId: 'b1', topologyVersion: 1 })
    sessions.requestConsent(sess2.id, 'o1', caps, ['observe_screen'])
    sessions.applyConsent(sess2.id, 'o1', consent, 1)
    sessions.activate(sess2.id, 'o1')
    const stopped = sessions.emergencyStop(sess2.id, 'o1')
    assert.equal(stopped.emergencyStopped, true)
    assert.equal(stopped.state, 'revoked')
    assert.throws(
      () => sessions.assertAuthorizedFor(sess2.id, 'o1', 'b1', 'observe_screen', 'sim-disp-1'),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'EMERGENCY_STOPPED',
    )
  })

  it('halts batches on uncertain outcomes, prevents duplicate/replay, and excludes sensitive data from audit logs', async () => {
    const backend = new SimulatedComputerUseBackend({
      displays: createDefaultSimulatedDisplays(),
      faults: { uncertainActionIds: new Set(['act-2']) },
    })
    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const controller = new ComputerUseActionController(backend, sessions, audit)

    const caps = await backend.getCapabilities()
    const sess = sessions.createSession({ ownerId: 'o1', botId: 'b1', topologyVersion: 1 })
    sessions.requestConsent(sess.id, 'o1', caps, ['observe_screen', 'pointer_control', 'keyboard_control'])
    const consent = await backend.requestConsent({
      sessionId: sess.id,
      requestedCapabilities: ['observe_screen', 'pointer_control', 'keyboard_control'],
      requestedDisplayIds: ['sim-disp-1'],
    })
    sessions.applyConsent(sess.id, 'o1', consent, 1)
    sessions.activate(sess.id, 'o1')

    const res = await controller.executeBatch({
      batchId: 'batch-1',
      sessionId: sess.id,
      ownerId: 'o1',
      botId: 'b1',
      actions: [
        {
          actionId: 'act-1',
          kind: 'text_entry',
          displayId: 'sim-disp-1',
          text: 'super-secret-password-input',
        },
        {
          actionId: 'act-2',
          kind: 'click',
          displayId: 'sim-disp-1',
          x: 50,
          y: 50,
          coordinateSpace: 'logical',
        },
        {
          actionId: 'act-3',
          kind: 'key_press',
          displayId: 'sim-disp-1',
          key: 'Enter',
        },
      ],
    })

    assert.equal(res.halted, true)
    assert.equal(res.results[0]?.status, 'completed')
    assert.equal(res.results[1]?.status, 'uncertain')
    assert.equal(res.results[1]?.uncertain, true)
    assert.equal(res.results[1]?.replayAllowed, false)
    assert.equal(res.results[2]?.status, 'cancelled')

    // Duplicate actionId is rejected (no automatic replay)
    await assert.rejects(
      () =>
        controller.executeBatch({
          batchId: 'batch-dup',
          sessionId: sess.id,
          ownerId: 'o1',
          botId: 'b1',
          actions: [
            {
              actionId: 'act-2',
              kind: 'click',
              displayId: 'sim-disp-1',
              x: 50,
              y: 50,
              coordinateSpace: 'logical',
            },
          ],
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'DUPLICATE_ACTION',
    )

    // Audit log must NOT contain raw typed text or screenshot bytes
    const events = audit.listBySession(sess.id, 'o1')
    assert.equal(events.length, 2)
    assert.ok(!JSON.stringify(events).includes('super-secret-password-input'))
  })

  it('cancels batches cleanly and marks uncertain on backend disconnect', async () => {
    const backend = new SimulatedComputerUseBackend()
    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const controller = new ComputerUseActionController(backend, sessions, audit)

    const caps = await backend.getCapabilities()
    const sess = sessions.createSession({ ownerId: 'o1', botId: 'b1', topologyVersion: 1 })
    sessions.requestConsent(sess.id, 'o1', caps, ['pointer_control'])
    const consent = await backend.requestConsent({
      sessionId: sess.id,
      requestedCapabilities: ['pointer_control'],
      requestedDisplayIds: ['sim-disp-1'],
    })
    sessions.applyConsent(sess.id, 'o1', consent, 1)
    sessions.activate(sess.id, 'o1')

    controller.cancelBatch('batch-cancel')
    const cancelled = await controller.executeBatch({
      batchId: 'batch-cancel',
      sessionId: sess.id,
      ownerId: 'o1',
      botId: 'b1',
      actions: [
        { actionId: 'c1', kind: 'move', displayId: 'sim-disp-1', x: 10, y: 10, coordinateSpace: 'logical' },
      ],
    })
    assert.equal(cancelled.halted, true)
    assert.equal(cancelled.results[0]?.status, 'cancelled')

    backend.disconnect()
    await assert.rejects(
      () =>
        controller.executeBatch({
          batchId: 'batch-disc',
          sessionId: sess.id,
          ownerId: 'o1',
          botId: 'b1',
          actions: [
            { actionId: 'd1', kind: 'move', displayId: 'sim-disp-1', x: 10, y: 10, coordinateSpace: 'logical' },
          ],
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'BACKEND_DISCONNECTED',
    )
  })
})
