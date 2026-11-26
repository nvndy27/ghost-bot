import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createDefaultSimulatedDisplays } from '../src/backends/simulated-backend.ts'
import { ComputerUseError, type ScreenshotMetadata } from '../src/contracts/types.ts'
import {
  MAX_BATCH_ACTIONS,
  MAX_TEXT_ENTRY_BYTES,
  MAX_WAIT_MS,
  validateAction,
  validateActionBatch,
} from '../src/validation/actions.ts'
import {
  logicalToPhysical,
  physicalToLogical,
  validateCaptureRegion,
  validateDisplayGeometry,
  validatePointerTarget,
} from '../src/validation/coordinates.ts'

describe('Coordinate & Action Validation', () => {
  const displays = createDefaultSimulatedDisplays()
  const primary = displays[0]!
  const hidpi = displays[1]!

  it('converts logical and physical coordinates accurately across scaled displays', () => {
    const phys = logicalToPhysical(hidpi, 320, 180)
    assert.deepEqual(phys, { x: 640, y: 360 })
    const log = physicalToLogical(hidpi, 640, 360)
    assert.deepEqual(log, { x: 320, y: 180 })

    // Negative display origin is valid
    assert.equal(validateDisplayGeometry(hidpi).originX, -1280)

    assert.throws(
      () => logicalToPhysical(primary, Number.NaN, 10),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_COORDINATES',
    )
    assert.throws(
      () => validateDisplayGeometry({ ...primary, scaleFactor: 0.1 }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_DISPLAY',
    )
  })

  it('validates capture regions and rejects out-of-bounds or stale observations', () => {
    const okRegion = validateCaptureRegion(hidpi, {
      displayId: hidpi.displayId,
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      coordinateSpace: 'logical',
    })
    assert.equal(okRegion.width, 640)

    assert.throws(
      () =>
        validateCaptureRegion(primary, {
          displayId: primary.displayId,
          x: 1900,
          y: 0,
          width: 100,
          height: 100,
          coordinateSpace: 'logical',
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_COORDINATES',
    )

    const staleObs: ScreenshotMetadata = {
      observationId: 'obs-1',
      sessionId: 'sess-1',
      displayId: primary.displayId,
      topologyVersion: 1,
      logicalWidth: 1920,
      logicalHeight: 1080,
      physicalWidth: 1920,
      physicalHeight: 1080,
      scaleFactor: 1,
      mimeType: 'image/raw',
      byteLength: 10,
      sha256: 'abc',
      capturedAt: new Date().toISOString(),
      isSimulation: true,
    }
    const updatedDisplays = [{ ...primary, topologyVersion: 2 }]

    assert.throws(
      () =>
        validatePointerTarget(updatedDisplays, {
          displayId: primary.displayId,
          x: 100,
          y: 100,
          coordinateSpace: 'logical',
          observation: staleObs,
        }),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'STALE_OBSERVATION',
    )
  })

  it('enforces action schemas, key allowlists, text limits, wait limits, and batch bounds', () => {
    validateAction(
      {
        actionId: 'a1',
        kind: 'click',
        displayId: primary.displayId,
        x: 500,
        y: 300,
        coordinateSpace: 'logical',
        description: 'Click button',
      },
      displays,
    )

    assert.throws(
      () =>
        validateAction(
          { actionId: 'bad-key', kind: 'key_press', displayId: primary.displayId, key: 'rm -rf /' },
          displays,
        ),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_ACTION',
    )

    assert.throws(
      () =>
        validateAction(
          {
            actionId: 'bad-text',
            kind: 'text_entry',
            displayId: primary.displayId,
            text: 'x'.repeat(MAX_TEXT_ENTRY_BYTES + 1),
          },
          displays,
        ),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_ACTION',
    )

    assert.throws(
      () =>
        validateAction({ actionId: 'bad-wait', kind: 'wait', durationMs: MAX_WAIT_MS + 1 }, displays),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'INVALID_ACTION',
    )

    const tooMany = Array.from({ length: MAX_BATCH_ACTIONS + 1 }, (_, i) => ({
      actionId: `w-${i}`,
      kind: 'wait' as const,
      durationMs: 1,
    }))
    assert.throws(
      () =>
        validateActionBatch(
          {
            batchId: 'b1',
            sessionId: 's1',
            ownerId: 'o1',
            botId: 'b1',
            actions: tooMany,
          },
          displays,
        ),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'BATCH_TOO_LARGE',
    )
  })
})
