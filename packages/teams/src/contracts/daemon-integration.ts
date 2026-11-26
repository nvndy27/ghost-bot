import type { TeamDispatchContext, TeamTaskStatus } from './types.ts'

/**
 * Narrow future daemon integration contracts for Phase 4C+.
 * Production approval resolution and runtime execution remain owned by apps/daemon.
 */

export interface DaemonPolicyRevalidationRequest {
  teamId: string
  teamRunId: string | null
  taskId: string
  ownerId: string
  assignedBotId: string
  requestedPermissionMode: 'read-only' | 'ask-approval' | 'workspace'
  requirePolicyRevalidation: true
  noPermissionEscalation: true
  reusePriorApprovals: false
}

export interface DaemonPolicyRevalidationDecision {
  allowed: boolean
  reasonCode: string
  resolvedPermissionMode: 'read-only' | 'ask-approval' | 'workspace'
  runtimeId: string | null
  accountId: string | null
}

export interface DaemonRuntimeSelection {
  botId: string
  providerId: string
  accountId: string
  modelId: string
  runtimeVersion: string
}

export interface DaemonWorkspaceGrant {
  botId: string
  canonicalWorkspacePath: string
  readOnly: boolean
  explicitSharedPaths: string[]
}

export interface DaemonTeamRunMapping {
  teamRunId: string
  taskId: string
  daemonRunId: string
  providerSessionId: string | null
}

export interface DaemonApprovalCorrelation {
  approvalId: string
  teamRunId: string
  taskId: string
  daemonRunId: string
  argsHash: string
  singleUse: true
  expiresAt: string
}

export interface DaemonCancellationAck {
  teamRunId: string
  taskId: string
  daemonRunId: string
  confirmedStopped: boolean
  reason: string | null
}

export interface DaemonResultStreamEvent {
  teamRunId: string
  taskId: string
  seq: number
  kind: 'progress' | 'partial_output' | 'completed' | 'failed' | 'uncertain'
  payload: string
  timestamp: string
}

export interface DaemonUsageReport {
  teamRunId: string
  taskId: string
  usageReported: boolean
  tokensUsed: number | null
  durationMs: number | null
  source: 'runtime' | 'unavailable'
}

export interface DaemonExecutionQuarantineEntry {
  teamRunId: string
  taskId: string
  daemonRunId: string
  status: Extract<TeamTaskStatus, 'uncertain'>
  quarantinedAt: string
  reason: string
}

export interface DaemonTeamBridgeContract {
  revalidateWorkerPolicy(
    req: DaemonPolicyRevalidationRequest,
  ): Promise<DaemonPolicyRevalidationDecision>
  selectRuntimeAndWorkspace(
    ctx: TeamDispatchContext,
  ): Promise<{ runtime: DaemonRuntimeSelection; workspace: DaemonWorkspaceGrant }>
  requestCancellation(mapping: DaemonTeamRunMapping): Promise<DaemonCancellationAck>
}
