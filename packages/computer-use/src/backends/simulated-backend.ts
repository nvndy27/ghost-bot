import { createHash, randomUUID } from 'node:crypto'
import {
  ComputerUseError,
  type CaptureRegion,
  type ComputerUseBackend,
  type ComputerUseCapabilities,
  type ComputerUseCapability,
  type ComputerUseErrorCode,
  type ConsentState,
  type DisplayGeometry,
  type KeyboardAction,
  type ObservationResult,
  type PointerAction,
} from '../contracts/types.ts'
import { validateCaptureRegion, validateDisplayGeometry } from '../validation/coordinates.ts'

export interface SimulatedFaultConfig {
  failActionIds?: Set<string>
  uncertainActionIds?: Set<string>
  failCode?: ComputerUseErrorCode
  failMessage?: string
  confirmCancellation?: boolean
}

export function createDefaultSimulatedDisplays(): DisplayGeometry[] {
  return [
    {
      displayId: 'sim-disp-1',
      name: 'Simulated Primary (1920x1080 @1x)',
      originX: 0,
      originY: 0,
      logicalWidth: 1920,
      logicalHeight: 1080,
      physicalWidth: 1920,
      physicalHeight: 1080,
      scaleFactor: 1,
      isPrimary: true,
      topologyVersion: 1,
    },
    {
      displayId: 'sim-disp-2',
      name: 'Simulated Secondary Left HiDPI (1280x720 @2x)',
      originX: -1280,
      originY: 0,
      logicalWidth: 1280,
      logicalHeight: 720,
      physicalWidth: 2560,
      physicalHeight: 1440,
      scaleFactor: 2,
      isPrimary: false,
      topologyVersion: 1,
    },
  ]
}

/**
 * Deterministic in-memory simulated ComputerUseBackend for offline testing.
 * Never interacts with any real desktop, Wayland compositor, or XDG Portal.
 */
export class SimulatedComputerUseBackend implements ComputerUseBackend {
  private capabilities: ComputerUseCapabilities
  private displays: DisplayGeometry[]
  private connected = true
  private readonly activeConsents = new Map<string, ConsentState>()
  private readonly faults: SimulatedFaultConfig
  readonly executedActions: Array<{ sessionId: string; action: PointerAction | KeyboardAction }> = []

  constructor(options?: {
    displays?: DisplayGeometry[]
    capabilities?: Partial<ComputerUseCapabilities>
    faults?: SimulatedFaultConfig
  }) {
    this.displays = (options?.displays ?? createDefaultSimulatedDisplays()).map((d) =>
      validateDisplayGeometry({ ...d }),
    )
    this.capabilities = {
      backendKind: 'simulated',
      isSimulation: true,
      discovery: options?.capabilities?.discovery ?? true,
      observeScreen: options?.capabilities?.observeScreen ?? true,
      pointerControl: options?.capabilities?.pointerControl ?? true,
      keyboardControl: options?.capabilities?.keyboardControl ?? true,
      multiMonitor: options?.capabilities?.multiMonitor ?? true,
      perDisplayConsentRequired: true,
      nativeWaylandVerified: false,
      notes: [
        'Simulated backend only; does not interact with host Wayland/Hyprland/GNOME desktop.',
        ...(options?.capabilities?.notes ?? []),
      ],
    }
    this.faults = options?.faults ?? {}
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new ComputerUseError('BACKEND_DISCONNECTED', 'Simulated backend is disconnected', true)
    }
  }

  disconnect(): void {
    this.connected = false
  }

  reconnect(): void {
    this.connected = true
  }

  updateDisplays(nextDisplays: DisplayGeometry[]): void {
    this.displays = nextDisplays.map((d) => validateDisplayGeometry({ ...d }))
  }

  async getCapabilities(): Promise<ComputerUseCapabilities> {
    this.assertConnected()
    return { ...this.capabilities, notes: [...this.capabilities.notes] }
  }

  async listDisplays(): Promise<DisplayGeometry[]> {
    this.assertConnected()
    return this.displays.map((d) => ({ ...d }))
  }

  async requestConsent(input: {
    sessionId: string
    requestedCapabilities: ComputerUseCapability[]
    requestedDisplayIds: string[]
  }): Promise<ConsentState> {
    this.assertConnected()
    for (const dId of input.requestedDisplayIds) {
      if (!this.displays.some((d) => d.displayId === dId)) {
        throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${dId}"`)
      }
    }
    const nowIso = new Date().toISOString()
    const consent: ConsentState = {
      status: 'granted',
      consentId: `sim_consent_${randomUUID()}`,
      isSimulated: true,
      grantedCapabilities: [...new Set(input.requestedCapabilities)],
      grantedDisplayIds: [...new Set(input.requestedDisplayIds)],
      grantedAt: nowIso,
      expiresAt: null,
      revokedAt: null,
    }
    this.activeConsents.set(input.sessionId, consent)
    return structuredClone(consent)
  }

  async revokeConsent(sessionId: string, _consentId: string): Promise<void> {
    this.assertConnected()
    const existing = this.activeConsents.get(sessionId)
    if (existing) {
      existing.status = 'revoked'
      existing.revokedAt = new Date().toISOString()
    }
  }

  async captureScreen(input: {
    sessionId: string
    displayId: string
    region?: CaptureRegion
    includeCursor?: boolean
  }): Promise<ObservationResult> {
    this.assertConnected()
    const display = this.displays.find((d) => d.displayId === input.displayId)
    if (!display) {
      throw new ComputerUseError('INVALID_DISPLAY', `Unknown displayId "${input.displayId}"`)
    }
    if (input.region) {
      validateCaptureRegion(display, input.region)
    }
    const consent = this.activeConsents.get(input.sessionId)
    if (!consent || consent.status !== 'granted' || !consent.grantedCapabilities.includes('observe_screen')) {
      throw new ComputerUseError('CONSENT_REQUIRED', 'Simulated observe_screen consent not active')
    }

    // Deterministic synthetic buffer (never captures real screen)
    const payload = Buffer.from(
      JSON.stringify({
        simulation: true,
        displayId: display.displayId,
        topologyVersion: display.topologyVersion,
        region: input.region ?? null,
      }),
      'utf8',
    )
    const sha256 = createHash('sha256').update(payload).digest('hex')

    return {
      metadata: {
        observationId: `sim_obs_${randomUUID()}`,
        sessionId: input.sessionId,
        displayId: display.displayId,
        topologyVersion: display.topologyVersion,
        logicalWidth: display.logicalWidth,
        logicalHeight: display.logicalHeight,
        physicalWidth: display.physicalWidth,
        physicalHeight: display.physicalHeight,
        scaleFactor: display.scaleFactor,
        mimeType: 'image/raw',
        byteLength: payload.byteLength,
        sha256,
        capturedAt: new Date().toISOString(),
        isSimulation: true,
      },
      buffer: new Uint8Array(payload),
    }
  }

  async executePointerAction(input: {
    sessionId: string
    action: PointerAction
  }): Promise<
    | { ok: true; durationMs: number }
    | { ok: false; uncertain?: boolean; code: ComputerUseErrorCode; message: string }
  > {
    this.assertConnected()
    if (this.faults.uncertainActionIds?.has(input.action.actionId)) {
      return {
        ok: false,
        uncertain: true,
        code: 'EXECUTION_UNCERTAIN',
        message: 'Simulated uncertain pointer outcome',
      }
    }
    if (this.faults.failActionIds?.has(input.action.actionId)) {
      return {
        ok: false,
        uncertain: false,
        code: this.faults.failCode ?? 'BACKEND_FAILED',
        message: this.faults.failMessage ?? 'Simulated pointer failure',
      }
    }
    this.executedActions.push({ sessionId: input.sessionId, action: input.action })
    return { ok: true, durationMs: 2 }
  }

  async executeKeyboardAction(input: {
    sessionId: string
    action: KeyboardAction
  }): Promise<
    | { ok: true; durationMs: number }
    | { ok: false; uncertain?: boolean; code: ComputerUseErrorCode; message: string }
  > {
    this.assertConnected()
    if (this.faults.uncertainActionIds?.has(input.action.actionId)) {
      return {
        ok: false,
        uncertain: true,
        code: 'EXECUTION_UNCERTAIN',
        message: 'Simulated uncertain keyboard outcome',
      }
    }
    if (this.faults.failActionIds?.has(input.action.actionId)) {
      return {
        ok: false,
        uncertain: false,
        code: this.faults.failCode ?? 'BACKEND_FAILED',
        message: this.faults.failMessage ?? 'Simulated keyboard failure',
      }
    }
    this.executedActions.push({ sessionId: input.sessionId, action: input.action })
    return { ok: true, durationMs: input.action.kind === 'wait' ? Math.min(input.action.durationMs, 5) : 2 }
  }

  async cancelSession(sessionId: string): Promise<{ confirmed: boolean; reason?: string }> {
    if (!this.connected) {
      return { confirmed: false, reason: 'Backend disconnected during cancellation' }
    }
    const existing = this.activeConsents.get(sessionId)
    if (existing) {
      existing.status = 'revoked'
      existing.revokedAt = new Date().toISOString()
    }
    const confirmed = this.faults.confirmCancellation ?? true
    return confirmed
      ? { confirmed: true }
      : { confirmed: false, reason: 'Simulated backend did not confirm stop' }
  }
}
