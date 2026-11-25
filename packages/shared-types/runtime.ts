// App-level runtime contracts. Provider adapters validate and normalize upstream messages.
export type PermissionMode = 'read-only' | 'ask-approval' | 'workspace' | 'full-access';
export type AuthKind = 'subscription' | 'api-key' | 'local';
export type AuthState = { status: 'connected' | 'disconnected' | 'pending' | 'error'; detail?: string };
export interface ModelInfo { id: string; label: string; efforts: string[]; permissionModes: PermissionMode[]; supportsTools: boolean; supportsAttachments: boolean }
export interface Capabilities { streaming: boolean; cancellation: boolean; resume: boolean; approvals: boolean; usage: boolean; sandbox: boolean; models: ModelInfo[] }
export interface UsageSnapshot { source: 'provider' | 'local' | 'estimated'; observedAt: string; windows: { label: string; usedPercent: number | null; resetAt: string | null }[]; inputTokens?: number; outputTokens?: number; costUsd?: number }
export interface SessionConfig { agentId: string; accountId: string; modelId: string; effort?: string; permission: PermissionMode; workspace: string; instructions: string }
export interface Session { id: string; externalId: string; runtimeId: string }
export interface AgentRequest { runId: string; session: Session; text: string; attachments?: string[] }
export interface ApprovalDecision { approvalId: string; runId: string; argsHash: string; decision: 'allow-once' | 'deny' }
export type EventPayload =
  | { type: 'message.delta'; text: string }
  | { type: 'tool.started' | 'tool.completed'; tool: string; callId: string; summary: string }
  | { type: 'approval.requested'; approvalId: string; tool: string; argsHash: string; summary: string; expiresAt: string }
  | { type: 'usage.updated'; usage: UsageSnapshot }
  | { type: 'artifact.created'; artifactId: string; name: string }
  | { type: 'run.completed' | 'run.cancelled' }
  | { type: 'run.failed'; code: string; message: string };
export type AgentEvent = EventPayload & { runId: string; seq: number; timestamp: string };
export interface AgentRuntime {
  readonly id: string;
  authenticate(): Promise<AuthState>;
  getAuthStatus(): Promise<AuthState>;
  disconnect(): Promise<void>;
  capabilities(): Promise<Capabilities>;
  listModels(): Promise<ModelInfo[]>;
  getUsage(): Promise<UsageSnapshot | null>;
  createSession(config: SessionConfig): Promise<Session>;
  run(request: AgentRequest): AsyncIterable<AgentEvent>;
  resolveApproval(decision: ApprovalDecision): Promise<void>;
  cancel(runId: string): Promise<void>;
}

/** Durable wire format emitted by the daemon after validation and redaction. */
export interface RuntimeEventV1 {
  version: 1;
  runtimeId: string;
  sessionId: string;
  runId: string;
  seq: number;
  timestamp: string;
  payload: EventPayload;
}
