import type {
  AgentEvent,
  AgentRequest,
  AgentRuntime,
  ApprovalDecision,
  AuthState,
  Capabilities,
  ModelInfo,
  Session,
  SessionConfig,
  UsageSnapshot,
} from '../../shared-types/runtime.ts'

/**
 * Explicitly labeled offline mock runtime for Phase 1 UI/smoke testing.
 * Never used as a silent fallback for real provider runtimes.
 */
export class MockRuntimeAdapter implements AgentRuntime {
  readonly id = 'mock-offline'
  private readonly cancelledRuns = new Set<string>()

  async authenticate(): Promise<AuthState> {
    return { status: 'connected', detail: 'Mock offline runtime (no provider connection)' }
  }

  async getAuthStatus(): Promise<AuthState> {
    return { status: 'connected', detail: 'Mock offline runtime (no provider connection)' }
  }

  async disconnect(): Promise<void> {
    this.cancelledRuns.clear()
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'mock-model',
        label: 'Mock Offline Model',
        efforts: ['low', 'medium'],
        permissionModes: ['read-only', 'ask-approval', 'workspace'],
        supportsTools: false,
        supportsAttachments: false,
      },
      // Keep the two pre-RC2 demo selections available only inside the
      // explicitly selected mock runtime. Existing profiles can reselect
      // these legacy IDs without treating them as real provider models.
      {
        id: 'gpt-6.2-mock',
        label: 'GPT-6.2 (Mock)',
        efforts: ['low', 'medium', 'high'],
        permissionModes: ['read-only', 'ask-approval', 'workspace'],
        supportsTools: false,
        supportsAttachments: false,
      },
      {
        id: 'codex-mock',
        label: 'Codex (Mock)',
        efforts: ['low', 'medium', 'high'],
        permissionModes: ['read-only', 'ask-approval', 'workspace'],
        supportsTools: false,
        supportsAttachments: false,
      },
    ]
  }

  async capabilities(): Promise<Capabilities> {
    return {
      streaming: true,
      cancellation: true,
      resume: false,
      approvals: false,
      usage: false,
      sandbox: false,
      models: await this.listModels(),
    }
  }

  async getUsage(): Promise<UsageSnapshot | null> {
    return null
  }

  async createSession(config: SessionConfig): Promise<Session> {
    return {
      id: `mock-session-${config.agentId}`,
      externalId: `mock-ext-${config.agentId}`,
      runtimeId: this.id,
    }
  }

  async *run(request: AgentRequest): AsyncIterable<AgentEvent> {
    const ts = () => new Date().toISOString()
    if (this.cancelledRuns.has(request.runId)) {
      yield { type: 'run.cancelled', runId: request.runId, seq: 1, timestamp: ts() }
      return
    }
    yield {
      type: 'message.delta',
      text: `[Mock response] ${request.text}`,
      runId: request.runId,
      seq: 1,
      timestamp: ts(),
    }
    yield { type: 'run.completed', runId: request.runId, seq: 2, timestamp: ts() }
  }

  async resolveApproval(_decision: ApprovalDecision): Promise<void> {
    // No-op in mock adapter.
  }

  async cancel(runId: string): Promise<void> {
    this.cancelledRuns.add(runId)
  }
}
