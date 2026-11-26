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
