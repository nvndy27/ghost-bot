import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ComputerUseAuditLog } from '../src/audit/audit-log.ts'
import { SimulatedComputerUseBackend } from '../src/backends/simulated-backend.ts'
import { normalizeAllowedOrigins, validateBrowserUrl } from '../src/browser/network-policy.ts'
import { ComputerUseActionController } from '../src/controller/action-controller.ts'
import { ComputerUseError } from '../src/contracts/types.ts'
import { ComputerUseSessionManager } from '../src/session/session-state-machine.ts'

describe('CU.2 Hardening & Network Policy', () => {
  it('serializes concurrent batches on the same session and rejects payload conflicts', async () => {
    const order: string[] = []
    const backend = new SimulatedComputerUseBackend()
    const origMove = backend.executePointerAction.bind(backend)
    backend.executePointerAction = async (input) => {
      order.push(`start:${input.action.actionId}`)
      await new Promise((r) => setTimeout(r, 15))
      order.push(`end:${input.action.actionId}`)
      return origMove(input)
    }

    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const ctrl = new ComputerUseActionController(backend, sessions, audit)
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

    await Promise.all([
      ctrl.executeBatch({
        batchId: 'b1',
        sessionId: sess.id,
        ownerId: 'o1',
        botId: 'b1',
        actions: [{ actionId: 'a1', kind: 'move', displayId: 'sim-disp-1', x: 1, y: 1, coordinateSpace: 'logical' }],
      }),
      ctrl.executeBatch({
        batchId: 'b2',
        sessionId: sess.id,
        ownerId: 'o1',
        botId: 'b1',
        actions: [{ actionId: 'a2', kind: 'move', displayId: 'sim-disp-1', x: 2, y: 2, coordinateSpace: 'logical' }],
      }),
    ])

    // Strictly serialized: a1 ends before a2 starts
    assert.deepEqual(order, ['start:a1', 'end:a1', 'start:a2', 'end:a2'])

    await assert.rejects(
      () =>
        ctrl.executeBatch({
          batchId: 'b3',
          sessionId: sess.id,
          ownerId: 'o1',
          botId: 'b1',
          actions: [{ actionId: 'a1', kind: 'move', displayId: 'sim-disp-1', x: 99, y: 99, coordinateSpace: 'logical' }],
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'DUPLICATE_ACTION',
    )
  })

  it('halts remaining actions when consent is revoked mid-flight and expires stale observations', async () => {
    const backend = new SimulatedComputerUseBackend()
    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const ctrl = new ComputerUseActionController(backend, sessions, audit, {
      maxObservationAgeMs: 50,
    })

    const caps = await backend.getCapabilities()
    const sess = sessions.createSession({ ownerId: 'o1', botId: 'b1', topologyVersion: 1 }, 1000)
    sessions.requestConsent(sess.id, 'o1', caps, ['observe_screen', 'pointer_control'], 1000)
    const consent = await backend.requestConsent({
      sessionId: sess.id,
      requestedCapabilities: ['observe_screen', 'pointer_control'],
      requestedDisplayIds: ['sim-disp-1'],
    })
    sessions.applyConsent(sess.id, 'o1', consent, 1, 1000)
    sessions.activate(sess.id, 'o1', 1000)

    const obs = await ctrl.captureScreen({
      sessionId: sess.id,
      ownerId: 'o1',
      botId: 'b1',
      displayId: 'sim-disp-1',
    })

    // Expired observation rejected when nowMs is far in the future
    await assert.rejects(
      () =>
        ctrl.executeBatch(
          {
            batchId: 'b-exp',
            sessionId: sess.id,
            ownerId: 'o1',
            botId: 'b1',
            actions: [
              {
                actionId: 'exp-1',
                kind: 'click',
                displayId: 'sim-disp-1',
                observationId: obs.metadata.observationId,
                x: 10,
                y: 10,
                coordinateSpace: 'logical',
              },
            ],
          },
          Date.parse(obs.metadata.capturedAt) + 100,
        ),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'STALE_OBSERVATION',
    )

    // Mid-flight revocation during action 1 halts action 2
    const origPtr = backend.executePointerAction.bind(backend)
    backend.executePointerAction = async (input) => {
      const r = await origPtr(input)
      sessions.emergencyStop(sess.id, 'o1')
      return r
    }

    const res = await ctrl.executeBatch({
      batchId: 'b-mid',
      sessionId: sess.id,
      ownerId: 'o1',
      botId: 'b1',
      actions: [
        { actionId: 'm1', kind: 'move', displayId: 'sim-disp-1', x: 10, y: 10, coordinateSpace: 'logical' },
        { actionId: 'm2', kind: 'move', displayId: 'sim-disp-1', x: 20, y: 20, coordinateSpace: 'logical' },
      ],
    })
    assert.equal(res.halted, true)
    assert.equal(res.results[0]?.status, 'completed')
    assert.equal(res.results[1]?.status, 'cancelled')
  })

  it('marks mid-batch backend disconnect as uncertain and cleans up on emergency stop', async () => {
    const backend = new SimulatedComputerUseBackend()
    const sessions = new ComputerUseSessionManager()
    const audit = new ComputerUseAuditLog()
    const ctrl = new ComputerUseActionController(backend, sessions, audit)
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

    const origPtr = backend.executePointerAction.bind(backend)
    backend.executePointerAction = async (input) => {
      if (input.action.actionId === 'u1') {
        backend.disconnect()
      }
      return origPtr(input)
    }

    const res = await ctrl.executeBatch({
      batchId: 'b-disc',
      sessionId: sess.id,
      ownerId: 'o1',
      botId: 'b1',
      actions: [
        { actionId: 'u1', kind: 'click', displayId: 'sim-disp-1', x: 10, y: 10, coordinateSpace: 'logical' },
        { actionId: 'u2', kind: 'click', displayId: 'sim-disp-1', x: 20, y: 20, coordinateSpace: 'logical' },
      ],
    })
    assert.equal(res.halted, true)
    assert.equal(res.results[0]?.status, 'uncertain')
    assert.equal(res.results[0]?.replayAllowed, false)
    assert.equal(res.results[1]?.status, 'cancelled')

    backend.reconnect()
    const stopRes = await ctrl.emergencyStopSession(sess.id, 'o1')
    assert.equal(stopRes.backendConfirmed, true)
  })

  it('enforces browser URL allowlist and rejects file, internal, and external URLs', () => {
    const allowed = normalizeAllowedOrigins(['http://127.0.0.1:4321'])
    assert.equal(validateBrowserUrl('http://127.0.0.1:4321/test', allowed).pathname, '/test')

    for (const bad of [
      'file:///etc/passwd',
      'chrome://settings',
      'javascript:alert(1)',
      'https://example.com/',
      'ws://127.0.0.1:4321/ws',
    ]) {
      assert.throws(
        () => validateBrowserUrl(bad, allowed),
        (err: unknown) => err instanceof ComputerUseError && err.code === 'SCOPE_FORBIDDEN',
      )
    }
  })
})
