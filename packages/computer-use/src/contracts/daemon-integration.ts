import type {
  ActionAuditEvent,
  ComputerUseCapabilities,
  ComputerUseCapability,
  ComputerUseSessionState,
} from './types.ts'

/**
 * Narrow future daemon integration contracts for Computer Use.
 * Production authorization, OS consent correlation, and policy enforcement remain owned by apps/daemon.
 */

export interface DaemonComputerUsePolicyRequest {
  ownerId: string
  botId: string
  runId: string
  runtimeSessionId: string | null
  requestedCapabilities: ComputerUseCapability[]
  requestedDisplayIds: string[]
  /** Teams and scheduled routines cannot inherit interactive Computer Use consent. */
  inheritedFromTeamOrRoutine: false
}

export interface DaemonComputerUsePolicyDecision {
  allowed: boolean
  reasonCode: string
  approvedCapabilities: ComputerUseCapability[]
  approvedDisplayIds: string[]
  requiresInteractiveApproval: boolean
}

export interface DaemonComputerUseApprovalCorrelation {
  approvalId: string
  computerUseSessionId: string
  runId: string
  botId: string
  capabilities: ComputerUseCapability[]
  displayIds: string[]
  singleUse: true
  expiresAt: string
}

export interface DaemonOsConsentCorrelation {
  computerUseSessionId: string
  portalSessionHandle: string
  restoreTokenPresent: false
  grantedCapabilities: ComputerUseCapability[]
  grantedDisplayIds: string[]
  grantedAt: string
}

export interface DaemonComputerUseEmergencyStop {
  sessionId: string
  ownerId: string
  reason: string
  requestedAt: string
  backendConfirmed: boolean
}

export interface DaemonComputerUseSettings {
  enabled: boolean
  allowObservation: boolean
  allowPointerControl: boolean
  allowKeyboardControl: boolean
  requireVisibleIndicator: boolean
  auditRetentionDays: number
  /** Simulated backend must never be presented as native Wayland control. */
  simulationModeOnly: boolean
}

export interface DaemonComputerUseBridgeContract {
  evaluatePolicy(req: DaemonComputerUsePolicyRequest): Promise<DaemonComputerUsePolicyDecision>
  getCapabilities(): Promise<ComputerUseCapabilities>
  getSessionState(sessionId: string, ownerId: string): Promise<ComputerUseSessionState>
  triggerEmergencyStop(stop: DaemonComputerUseEmergencyStop): Promise<void>
  recordAuditEvent(event: ActionAuditEvent): Promise<void>
}

export interface DaemonBrowserSessionOwnership {
  browserSessionId: string
  ownerId: string
  botId: string
  runId: string
  allowedOrigins: string[]
  inheritedFromTeamOrRoutine: false
}

export interface DaemonBrowserCapabilityAuth {
  browserSessionId: string
  allowNavigation: boolean
  allowObservation: boolean
  allowInteraction: boolean
  expiresAt: string
}

export interface DaemonLiveObservationFrame {
  browserSessionId: string
  tabId: string
  navigationGeneration: number
  observationId: string
  capturedAt: string
  mimeType: 'image/png' | 'image/raw'
  byteLength: number
}

export interface DaemonBrowserBridgeContract {
  authorizeBrowserSession(
    ownership: DaemonBrowserSessionOwnership,
    requested: Omit<DaemonBrowserCapabilityAuth, 'expiresAt'>,
  ): Promise<DaemonBrowserCapabilityAuth>
  publishObservationMetadata(frame: DaemonLiveObservationFrame): Promise<void>
  emergencyStopBrowser(sessionId: string, ownerId: string, reason: string): Promise<void>
}
