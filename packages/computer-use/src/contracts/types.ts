export type ComputerUseCapability =
  | 'discovery'
  | 'observe_screen'
  | 'pointer_control'
  | 'keyboard_control'

export type ComputerUseErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_COORDINATES'
  | 'INVALID_DISPLAY'
  | 'STALE_OBSERVATION'
  | 'INVALID_ACTION'
  | 'BATCH_TOO_LARGE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_REVOKED'
  | 'SESSION_EXPIRED'
  | 'SESSION_NOT_FOUND'
  | 'INVALID_STATE_TRANSITION'
  | 'SCOPE_FORBIDDEN'
  | 'DUPLICATE_ACTION'
  | 'EXECUTION_UNCERTAIN'
  | 'EMERGENCY_STOPPED'
  | 'BACKEND_DISCONNECTED'
  | 'BACKEND_FAILED'

export class ComputerUseError extends Error {
  readonly code: ComputerUseErrorCode
  readonly retryable: boolean

  constructor(code: ComputerUseErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ComputerUseError'
    this.code = code
    this.retryable = retryable
  }
}

export interface ComputerUseCapabilities {
  backendKind: 'simulated' | 'wayland-portal' | 'x11' | 'virtual-desktop'
  isSimulation: boolean
  discovery: boolean
  observeScreen: boolean
  pointerControl: boolean
  keyboardControl: boolean
  multiMonitor: boolean
  perDisplayConsentRequired: boolean
  nativeWaylandVerified: boolean
  notes: string[]
}

export interface DisplayGeometry {
  displayId: string
  name: string
  originX: number
  originY: number
  logicalWidth: number
  logicalHeight: number
  physicalWidth: number
  physicalHeight: number
  scaleFactor: number
  isPrimary: boolean
  topologyVersion: number
}

export interface CaptureRegion {
  displayId: string
  x: number
  y: number
  width: number
  height: number
  coordinateSpace: 'logical' | 'physical'
}

export interface CaptureRequest {
  sessionId: string
  ownerId: string
  botId: string
  displayId: string
  region?: CaptureRegion
  includeCursor?: boolean
}

export interface ScreenshotMetadata {
  observationId: string
  sessionId: string
  displayId: string
  topologyVersion: number
  logicalWidth: number
  logicalHeight: number
  physicalWidth: number
  physicalHeight: number
  scaleFactor: number
  mimeType: 'image/png' | 'image/raw'
  byteLength: number
  sha256: string
  capturedAt: string
  isSimulation: boolean
}

export interface ObservationResult {
  metadata: ScreenshotMetadata
  buffer: Uint8Array
}

export type CoordinateSpace = 'logical' | 'physical'

export interface PointerBase {
  actionId: string
  displayId: string
  observationId?: string
  topologyVersion?: number
  coordinateSpace: CoordinateSpace
  /** Informational only; never grants authorization. */
  description?: string
}

export type PointerAction =
  | (PointerBase & { kind: 'move'; x: number; y: number })
  | (PointerBase & {
      kind: 'click'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    })
  | (PointerBase & {
      kind: 'double_click'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
    })
  | (PointerBase & {
      kind: 'drag'
      fromX: number
      fromY: number
      toX: number
      toY: number
      button?: 'left' | 'right' | 'middle'
    })
  | (PointerBase & {
      kind: 'scroll'
      x: number
      y: number
      deltaX: number
      deltaY: number
    })

export interface KeyboardBase {
  actionId: string
  displayId: string
  /** Informational only; never grants authorization. */
  description?: string
}

export type KeyboardAction =
  | (KeyboardBase & { kind: 'key_press'; key: string })
  | (KeyboardBase & { kind: 'key_release'; key: string })
  | (KeyboardBase & { kind: 'key_combo'; keys: string[] })
  | (KeyboardBase & { kind: 'text_entry'; text: string })
  | { kind: 'wait'; actionId: string; durationMs: number; description?: string }

export type ComputerUseAction = PointerAction | KeyboardAction

export interface ActionBatch {
  batchId: string
  sessionId: string
  ownerId: string
  botId: string
  actions: ComputerUseAction[]
}

export type ActionOutcomeStatus =
  | 'requested'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'uncertain'

export interface ActionResult {
  actionId: string
  category: 'pointer' | 'keyboard' | 'wait'
  capability: ComputerUseCapability
  status: ActionOutcomeStatus
  startedAt: string | null
  endedAt: string | null
  durationMs: number
  uncertain: boolean
  replayAllowed: false
  errorCode: string | null
  errorMessage: string | null
  isSimulation: boolean
}

export interface BatchExecutionResult {
  batchId: string
  sessionId: string
  halted: boolean
  haltReason: string | null
  results: ActionResult[]
}

export interface SessionPermissionScope {
  ownerId: string
  botId: string
  runtimeSessionId: string | null
  allowedCapabilities: ComputerUseCapability[]
  allowedDisplayIds: string[]
  topologyVersion: number
}

export interface ConsentState {
  status: 'none' | 'pending' | 'granted' | 'revoked' | 'expired'
  consentId: string | null
  isSimulated: boolean
  grantedCapabilities: ComputerUseCapability[]
  grantedDisplayIds: string[]
  grantedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export type ComputerUseSessionState =
  | 'unavailable'
  | 'idle'
  | 'consent_required'
  | 'authorized'
  | 'active'
  | 'paused'
  | 'revoking'
  | 'revoked'
  | 'expired'
  | 'interrupted'
  | 'failed'

export interface ComputerUseSession {
  id: string
  ownerId: string
  botId: string
  runtimeSessionId: string | null
  state: ComputerUseSessionState
  scope: SessionPermissionScope
  consent: ConsentState
  emergencyStopped: boolean
  lastTopologyVersion: number | null
  createdAt: string
  updatedAt: string
  expiresAt: string | null
}

export interface ActionAuditEvent {
  eventId: string
  sessionId: string
  ownerId: string
  botId: string
  actionId: string
  category: 'session' | 'observe' | 'pointer' | 'keyboard' | 'wait'
  capability: ComputerUseCapability
  timestamp: string
  outcome: ActionOutcomeStatus | 'denied' | 'revoked' | 'emergency_stop'
  sanitizedError: string | null
  isSimulation: boolean
}

export interface ComputerUseBackend {
  getCapabilities(): Promise<ComputerUseCapabilities>
  listDisplays(): Promise<DisplayGeometry[]>
  requestConsent(input: {
    sessionId: string
    requestedCapabilities: ComputerUseCapability[]
    requestedDisplayIds: string[]
  }): Promise<ConsentState>
  revokeConsent(sessionId: string, consentId: string): Promise<void>
  captureScreen(input: {
    sessionId: string
    displayId: string
    region?: CaptureRegion
    includeCursor?: boolean
  }): Promise<ObservationResult>
  executePointerAction(input: {
    sessionId: string
    action: PointerAction
  }): Promise<{ ok: true; durationMs: number } | { ok: false; uncertain?: boolean; code: ComputerUseErrorCode; message: string }>
  executeKeyboardAction(input: {
    sessionId: string
    action: KeyboardAction
  }): Promise<{ ok: true; durationMs: number } | { ok: false; uncertain?: boolean; code: ComputerUseErrorCode; message: string }>
  cancelSession(sessionId: string): Promise<{ confirmed: boolean; reason?: string }>
}
