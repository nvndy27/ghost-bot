import { canEnablePermission } from '@ghost-bot/shared-types/permissions'
import type { RuntimePermissionEvidence } from '@ghost-bot/shared-types/permissions'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'

export function resolveCodexVerifiedEvidence(
  codexVersion: string | null,
): RuntimePermissionEvidence | null {
  if (!codexVersion) return null
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(codexVersion.trim())
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 0 || (major === 0 && minor >= 172)) {
    return {
      sandboxEnforced: true,
      approvalEnforced: true,
      sensitiveActionsEnforced: true,
      verifiedModes: ['read-only', 'ask-approval', 'workspace'],
    }
  }
  return null
}

export interface PolicyAuthorizationInput {
  runtimeMode: 'codex' | 'mock'
  codexVersion: string | null
  authMethod: 'chatgpt' | 'apiKey' | 'mock' | 'none'
  requestedPermission: PermissionMode
  canonicalWorkspace: string | null
}

export interface PolicyAuthorizationDecision {
  allowed: boolean
  reason: string
  verifiedModes: ('read-only' | 'ask-approval' | 'workspace')[]
}

/**
 * Separates runtime capabilities, user preferences, and verified permission evidence.
 * A persisted bot configuration alone never grants execution authorization.
 */
export class RuntimePolicyBroker {
  authorize(input: PolicyAuthorizationInput): PolicyAuthorizationDecision {
    const evidence =
      input.runtimeMode === 'codex'
        ? resolveCodexVerifiedEvidence(input.codexVersion)
        : null

    const verifiedModes = (evidence?.verifiedModes ?? []).filter(
      (m): m is 'read-only' | 'ask-approval' | 'workspace' => m !== 'full-access',
    )

    if (input.requestedPermission === 'full-access') {
      return {
        allowed: false,
        reason: 'Full Access is disabled and rejected by policy',
        verifiedModes,
      }
    }

    if (input.runtimeMode === 'mock') {
      return {
        allowed: false,
        reason: 'Mock runtime is for offline UI preview only, not real execution',
        verifiedModes: [],
      }
    }

    if (!evidence) {
      return {
        allowed: false,
        reason: 'Codex runtime version does not have verified permission evidence',
        verifiedModes,
      }
    }

    if (input.authMethod !== 'chatgpt') {
      return {
        allowed: false,
        reason:
          input.authMethod === 'apiKey'
            ? 'API-key accounts are blocked without explicit opt-in'
            : 'Verified ChatGPT subscription authentication is required',
        verifiedModes,
      }
    }

    if (!input.canonicalWorkspace) {
      return {
        allowed: false,
        reason: 'A valid canonicalized workspace directory is required',
        verifiedModes,
      }
    }

    if (!canEnablePermission(input.requestedPermission, evidence, false)) {
      return {
        allowed: false,
        reason: `Permission mode '${input.requestedPermission}' failed runtime capability check`,
        verifiedModes,
      }
    }

    return {
      allowed: true,
      reason: 'Authorized under verified Codex sandbox and approval policy',
      verifiedModes,
    }
  }
}
