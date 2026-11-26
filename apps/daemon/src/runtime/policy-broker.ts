import type { HostMcpPolicyAdapter } from '@ghost-bot/mcp'
import { canEnablePermission } from '@ghost-bot/shared-types/permissions'
import type { RuntimePermissionEvidence } from '@ghost-bot/shared-types/permissions'
import type { PermissionMode } from '@ghost-bot/shared-types/runtime'

const VERIFIED_CODEX_VERSIONS = new Set(['0.172.0'])

export function resolveCodexVerifiedEvidence(
  codexVersion: string | null,
): RuntimePermissionEvidence | null {
  if (!codexVersion) return null
  const normalized = codexVersion.trim()
  if (!VERIFIED_CODEX_VERSIONS.has(normalized)) {
    return null
  }
  return {
    sandboxEnforced: true,
    approvalEnforced: true,
    sensitiveActionsEnforced: true,
    verifiedModes: ['read-only', 'ask-approval', 'workspace'],
  }
}

export interface PolicyAuthorizationInput {
  runtimeMode: 'codex' | 'openclaw' | 'ollama' | 'mock'
  codexVersion: string | null
  authMethod: 'chatgpt' | 'apiKey' | 'mock' | 'none'
  requestedPermission: PermissionMode
  canonicalWorkspace: string | null
  openClawVersion?: string | null
  openClawExecutionAuthorized?: boolean
  openClawLoopbackVerified?: boolean
  openClawSandboxVerified?: boolean
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

    if (input.runtimeMode === 'openclaw') {
      return this.authorizeOpenClawExecution({
        requestedPermission: input.requestedPermission,
        canonicalWorkspace: input.canonicalWorkspace,
        openClawVersion: input.openClawVersion ?? null,
        openClawExecutionAuthorized: input.openClawExecutionAuthorized ?? false,
        openClawLoopbackVerified: input.openClawLoopbackVerified ?? false,
        openClawSandboxVerified: input.openClawSandboxVerified ?? false,
      })
    }

    if (input.runtimeMode === 'ollama') {
      return {
        allowed: false,
        reason:
          'Ollama local execution requires explicit local-model opt-in and supports read-only chat without tools',
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

  /**
   * Phase 2C live execution gate: permits verified read-only, ask-approval, and workspace modes
   * under exact-version Codex 0.172.0 evidence and ChatGPT auth, while rejecting full-access.
   */
  authorizeLiveExecution(input: PolicyAuthorizationInput): PolicyAuthorizationDecision {
    return this.authorize(input)
  }

  authorizeOpenClawExecution(input: {
    requestedPermission: PermissionMode
    canonicalWorkspace: string | null
    openClawVersion: string | null
    openClawExecutionAuthorized: boolean
    openClawLoopbackVerified: boolean
    openClawSandboxVerified: boolean
  }): PolicyAuthorizationDecision {
    if (input.requestedPermission === 'full-access') {
      return {
        allowed: false,
        reason: 'Full Access is disabled for OpenClaw Gateway execution',
        verifiedModes: [],
      }
    }
    if (!input.openClawExecutionAuthorized) {
      return {
        allowed: false,
        reason:
          'OpenClaw live execution is gated until Gateway sandbox, billing, and explicit user authorization are verified',
        verifiedModes: [],
      }
    }
    if (input.openClawVersion !== '2026.11.8') {
      return {
        allowed: false,
        reason: `OpenClaw Gateway version "${input.openClawVersion ?? 'unknown'}" is not verified for execution`,
        verifiedModes: [],
      }
    }
    if (!input.openClawLoopbackVerified) {
      return {
        allowed: false,
        reason: 'OpenClaw Gateway must be verified on loopback (ws://127.0.0.1 / localhost / ::1)',
        verifiedModes: [],
      }
    }
    if (input.requestedPermission !== 'read-only' && !input.openClawSandboxVerified) {
      return {
        allowed: false,
        reason: `OpenClaw Gateway sandbox/approval enforcement is not verified for "${input.requestedPermission}" mode`,
        verifiedModes: ['read-only'],
      }
    }
    if (!input.canonicalWorkspace) {
      return {
        allowed: false,
        reason: 'A valid canonicalized workspace directory is required',
        verifiedModes: ['read-only'],
      }
    }
    return {
      allowed: true,
      reason: 'Authorized for bounded OpenClaw Gateway execution',
      verifiedModes: input.openClawSandboxVerified
        ? ['read-only', 'ask-approval', 'workspace']
        : ['read-only'],
    }
  }

  /**
   * Creates a HostMcpPolicyAdapter bound to a bot/run permission mode.
   * Blocks local STDIO MCP launch and tool invocation under `full-access` and `read-only`;
   * permits `ask-approval` and `workspace` (with per-call durable approval enforced by the orchestrator).
   */
  createMcpPolicyAdapter(permissionMode: PermissionMode): HostMcpPolicyAdapter {
    return createHostMcpPolicyAdapter(permissionMode)
  }

  /**
   * Authorizes Computer Use session creation and capability boundaries.
   * Separates observation from side-effecting navigation/interaction, rejects inherited
   * Teams/Scheduler consent, and keeps live model-driven Computer Use disabled.
   */
  evaluateComputerUsePolicy(input: {
    requestedPermission: PermissionMode
    explicitConsent: boolean
    inheritedFromTeamOrRoutine: boolean
    allowObservation: boolean
    allowNavigation: boolean
    allowInteraction: boolean
    liveModelDriven?: boolean
  }): {
    allowed: boolean
    reasonCode: string
    reason: string
    allowObservation: boolean
    allowNavigation: boolean
    allowInteraction: boolean
    requiresSingleUseApproval: boolean
  } {
    if (input.requestedPermission === 'full-access') {
      return {
        allowed: false,
        reasonCode: 'CU_FULL_ACCESS_DENIED',
        reason: 'Full Access is disabled for Computer Use',
        allowObservation: false,
        allowNavigation: false,
        allowInteraction: false,
        requiresSingleUseApproval: true,
      }
    }
    if (input.inheritedFromTeamOrRoutine !== false) {
      return {
        allowed: false,
        reasonCode: 'CU_INHERITED_CONSENT_FORBIDDEN',
        reason: 'Computer Use consent cannot be inherited from Teams or Scheduler routines',
        allowObservation: false,
        allowNavigation: false,
        allowInteraction: false,
        requiresSingleUseApproval: true,
      }
    }
    if (input.explicitConsent !== true) {
      return {
        allowed: false,
        reasonCode: 'CU_CONSENT_REQUIRED',
        reason: 'Explicit user consent is required to start a Computer Use session',
        allowObservation: false,
        allowNavigation: false,
        allowInteraction: false,
        requiresSingleUseApproval: true,
      }
    }
    if (input.liveModelDriven === true) {
      return {
        allowed: false,
        reasonCode: 'LIVE_MODEL_DRIVEN_CU_DISABLED',
        reason: 'Live model-driven Computer Use is disabled in CU.4',
        allowObservation: false,
        allowNavigation: false,
        allowInteraction: false,
        requiresSingleUseApproval: true,
      }
    }
    if (input.requestedPermission === 'read-only' && (input.allowNavigation || input.allowInteraction)) {
      return {
        allowed: false,
        reasonCode: 'CU_READ_ONLY_BLOCKS_MUTATION',
        reason: 'Read-Only permission mode permits observation only, not browser navigation or interaction',
        allowObservation: false,
        allowNavigation: false,
        allowInteraction: false,
        requiresSingleUseApproval: true,
      }
    }
    return {
      allowed: true,
      reasonCode: 'CU_AUTHORIZED',
      reason: 'Authorized under isolated Computer Use policy with single-use action approval',
      allowObservation: input.allowObservation,
      allowNavigation: input.allowNavigation,
      allowInteraction: input.allowInteraction,
      requiresSingleUseApproval: true,
    }
  }
}

export function createHostMcpPolicyAdapter(permissionMode: PermissionMode): HostMcpPolicyAdapter {
  const evaluate = (action: 'launch' | 'tool'): { allowed: boolean; reason?: string } => {
    if (permissionMode === 'full-access') {
      return {
        allowed: false,
        reason: `Full Access mode is blocked for local STDIO MCP ${action}`,
      }
    }
    if (permissionMode === 'read-only') {
      return {
        allowed: false,
        reason: `Read-Only mode blocks local STDIO MCP ${action}`,
      }
    }
    if (permissionMode === 'workspace') {
      return {
        allowed: false,
        reason: `Workspace mode blocks unsandboxed local STDIO MCP ${action} (cannot enforce workspace containment or network isolation)`,
      }
    }
    return { allowed: true }
  }

  return {
    evaluateLaunch: () => evaluate('launch'),
    evaluateToolInvocation: () => evaluate('tool'),
  }
}
