import { randomUUID } from 'node:crypto'
import {
  ComputerUseError,
  type ComputerUseCapabilities,
  type ComputerUseCapability,
  type ComputerUseSession,
  type ComputerUseSessionState,
  type ConsentState,
} from '../contracts/types.ts'

const ALLOWED_TRANSITIONS: Record<ComputerUseSessionState, Set<ComputerUseSessionState>> = {
  unavailable: new Set(['idle']),
  idle: new Set(['consent_required', 'unavailable', 'revoked']),
  consent_required: new Set(['authorized', 'revoked', 'expired', 'failed']),
  authorized: new Set(['active', 'paused', 'revoking', 'revoked', 'expired', 'failed']),
  active: new Set(['paused', 'revoking', 'revoked', 'expired', 'interrupted', 'failed']),
  paused: new Set(['active', 'revoking', 'revoked', 'expired', 'interrupted', 'failed']),
  revoking: new Set(['revoked', 'failed', 'interrupted']),
  revoked: new Set([]),
  expired: new Set([]),
  interrupted: new Set(['revoked']),
  failed: new Set(['revoked']),
}

export class ComputerUseSessionManager {
  private readonly sessions = new Map<string, ComputerUseSession>()

  createSession(
    input: {
      ownerId: string
      botId: string
      runtimeSessionId?: string | null
      topologyVersion: number
      ttlMs?: number
    },
    nowMs = Date.now(),
  ): ComputerUseSession {
    if (!input.ownerId.trim() || !input.botId.trim()) {
      throw new ComputerUseError('INVALID_INPUT', 'ownerId and botId are required')
    }
    const id = `cu_sess_${randomUUID()}`
    const nowIso = new Date(nowMs).toISOString()
    const expiresAt = input.ttlMs ? new Date(nowMs + input.ttlMs).toISOString() : null

    const session: ComputerUseSession = {
      id,
      ownerId: input.ownerId,
      botId: input.botId,
      runtimeSessionId: input.runtimeSessionId ?? null,
      state: 'idle',
      scope: {
        ownerId: input.ownerId,
        botId: input.botId,
        runtimeSessionId: input.runtimeSessionId ?? null,
        allowedCapabilities: ['discovery'],
        allowedDisplayIds: [],
        topologyVersion: input.topologyVersion,
      },
      consent: {
        status: 'none',
        consentId: null,
        isSimulated: false,
        grantedCapabilities: [],
        grantedDisplayIds: [],
        grantedAt: null,
        expiresAt,
        revokedAt: null,
      },
      emergencyStopped: false,
      lastTopologyVersion: input.topologyVersion,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
    }
    this.sessions.set(id, session)
    return structuredClone(session)
  }

  getSession(sessionId: string, ownerId: string, botId?: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) {
      throw new ComputerUseError('SESSION_NOT_FOUND', `Computer Use session "${sessionId}" not found`)
    }
    if (s.ownerId !== ownerId || (botId !== undefined && s.botId !== botId)) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Computer Use session access denied outside owner/bot scope')
    }
    if (
      s.expiresAt &&
      nowMs >= Date.parse(s.expiresAt) &&
      s.state !== 'expired' &&
      s.state !== 'revoked'
    ) {
      s.state = 'expired'
      s.consent.status = 'expired'
      s.updatedAt = new Date(nowMs).toISOString()
    }
    return structuredClone(s)
  }

  private transition(session: ComputerUseSession, next: ComputerUseSessionState, nowMs: number): void {
    if (!ALLOWED_TRANSITIONS[session.state].has(next)) {
      throw new ComputerUseError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition Computer Use session from "${session.state}" to "${next}"`,
      )
    }
    session.state = next
    session.updatedAt = new Date(nowMs).toISOString()
  }

  requestConsent(
    sessionId: string,
    ownerId: string,
    capabilities: ComputerUseCapabilities,
    requestedCapabilities: ComputerUseCapability[],
    nowMs = Date.now(),
  ): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')

    for (const cap of requestedCapabilities) {
      if (cap === 'observe_screen' && !capabilities.observeScreen) {
        throw new ComputerUseError('UNSUPPORTED_CAPABILITY', 'Screen observation is unsupported by backend')
      }
      if (cap === 'pointer_control' && !capabilities.pointerControl) {
        throw new ComputerUseError('UNSUPPORTED_CAPABILITY', 'Pointer control is unsupported by backend')
      }
      if (cap === 'keyboard_control' && !capabilities.keyboardControl) {
        throw new ComputerUseError('UNSUPPORTED_CAPABILITY', 'Keyboard control is unsupported by backend')
      }
    }

    this.transition(s, 'consent_required', nowMs)
    s.consent.status = 'pending'
    return structuredClone(s)
  }

  applyConsent(
    sessionId: string,
    ownerId: string,
    consent: ConsentState,
    topologyVersion: number,
    nowMs = Date.now(),
  ): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    if (s.emergencyStopped) {
      throw new ComputerUseError('EMERGENCY_STOPPED', 'Cannot grant consent after emergency stop')
    }
    if (consent.status !== 'granted') {
      this.transition(s, 'revoked', nowMs)
      s.consent = structuredClone(consent)
      return structuredClone(s)
    }

    this.transition(s, 'authorized', nowMs)
    s.consent = structuredClone(consent)
    s.scope.allowedCapabilities = [...new Set<ComputerUseCapability>(['discovery', ...consent.grantedCapabilities])]
    s.scope.allowedDisplayIds = [...new Set(consent.grantedDisplayIds)]
    s.scope.topologyVersion = topologyVersion
    s.lastTopologyVersion = topologyVersion
    return structuredClone(s)
  }

  activate(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const current = this.getSession(sessionId, ownerId, undefined, nowMs)
    if (current.state === 'expired') {
      throw new ComputerUseError('SESSION_EXPIRED', 'Computer Use session has expired')
    }
    if (current.emergencyStopped) {
      throw new ComputerUseError('EMERGENCY_STOPPED', 'Session is emergency-stopped')
    }
    const s = this.sessions.get(sessionId)!
    this.transition(s, 'active', nowMs)
    return structuredClone(s)
  }

  pause(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    this.transition(s, 'paused', nowMs)
    return structuredClone(s)
  }

  beginRevocation(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    if (s.state === 'revoked') return structuredClone(s)
    if (s.state === 'idle' || s.state === 'consent_required' || s.state === 'interrupted' || s.state === 'failed') {
      this.transition(s, 'revoked', nowMs)
      s.consent.status = 'revoked'
      s.consent.revokedAt = new Date(nowMs).toISOString()
      s.scope.allowedCapabilities = []
      s.scope.allowedDisplayIds = []
      return structuredClone(s)
    }
    this.transition(s, 'revoking', nowMs)
    return structuredClone(s)
  }

  completeRevocation(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    if (s.state !== 'revoked') {
      this.transition(s, 'revoked', nowMs)
    }
    s.consent.status = 'revoked'
    s.consent.revokedAt = new Date(nowMs).toISOString()
    s.scope.allowedCapabilities = []
    s.scope.allowedDisplayIds = []
    return structuredClone(s)
  }

  emergencyStop(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    s.emergencyStopped = true
    s.consent.status = 'revoked'
    s.consent.revokedAt = new Date(nowMs).toISOString()
    s.scope.allowedCapabilities = []
    s.scope.allowedDisplayIds = []
    if (s.state !== 'revoked' && s.state !== 'expired') {
      s.state = 'revoked'
    }
    s.updatedAt = new Date(nowMs).toISOString()
    return structuredClone(s)
  }

  markInterrupted(sessionId: string, ownerId: string, nowMs = Date.now()): ComputerUseSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Session not found')
    if (s.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    if (s.state === 'active' || s.state === 'paused' || s.state === 'revoking') {
      this.transition(s, 'interrupted', nowMs)
    }
    return structuredClone(s)
  }

  assertAuthorizedFor(
    sessionId: string,
    ownerId: string,
    botId: string,
    capability: ComputerUseCapability,
    displayId?: string,
    nowMs = Date.now(),
  ): ComputerUseSession {
    const s = this.getSession(sessionId, ownerId, botId, nowMs)
    if (s.emergencyStopped) {
      throw new ComputerUseError('EMERGENCY_STOPPED', 'Session has been emergency-stopped')
    }
    if (s.state === 'expired') {
      throw new ComputerUseError('SESSION_EXPIRED', 'Computer Use session has expired')
    }
    if (s.state === 'revoked' || s.state === 'revoking' || s.consent.status === 'revoked') {
      throw new ComputerUseError('CONSENT_REVOKED', 'Computer Use consent has been revoked')
    }
    if (s.state !== 'active') {
      throw new ComputerUseError(
        'CONSENT_REQUIRED',
        `Computer Use session is "${s.state}" and not active/authorized`,
      )
    }
    if (!s.scope.allowedCapabilities.includes(capability)) {
      throw new ComputerUseError(
        'CONSENT_REQUIRED',
        `Session does not hold capability "${capability}"`,
      )
    }
    if (displayId !== undefined && !s.scope.allowedDisplayIds.includes(displayId)) {
      throw new ComputerUseError(
        'SCOPE_FORBIDDEN',
        `Display "${displayId}" is not in session authorized display scope`,
      )
    }
    return s
  }
}
