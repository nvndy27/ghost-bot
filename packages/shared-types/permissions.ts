import type { PermissionMode } from './runtime.ts'

export interface RuntimePermissionEvidence {
  sandboxEnforced: boolean
  approvalEnforced: boolean
  sensitiveActionsEnforced: boolean
  verifiedModes: readonly PermissionMode[]
}

// Preflight only. A runtime must still enforce the selected mode during execution.
export function canEnablePermission(
  mode: PermissionMode,
  evidence: RuntimePermissionEvidence | null,
  fullAccessOptIn = false,
): boolean {
  if (!evidence?.verifiedModes.includes(mode) || !evidence.sensitiveActionsEnforced) return false
  if (mode === 'full-access') return fullAccessOptIn
  if (!evidence.sandboxEnforced) return false
  if (mode === 'read-only') return true
  return evidence.approvalEnforced
}
