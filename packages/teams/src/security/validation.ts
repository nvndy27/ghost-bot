import type { CreateTeamInput, TeamExecutionBounds } from '../contracts/types.ts'

export const MAX_TEAM_NAME_CHARS = 120
export const MAX_TEAM_DESC_CHARS = 1000
export const MAX_TEAM_MEMBERS = 12
export const MAX_PROMPT_BYTES = 16 * 1024
export const MAX_MESSAGE_BYTES = 16 * 1024
export const MAX_DEPTH_LIMIT = 5
export const MAX_ATTEMPTS_LIMIT = 5
export const MAX_TOKENS_LIMIT = 500_000
export const MAX_DURATION_MS_LIMIT = 3_600_000
export const MAX_CONCURRENT_LIMIT = 6

export class TeamError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(redactTeamSecrets(message))
    this.name = 'TeamError'
    this.code = code
  }
}

export function redactTeamSecrets(input: string): string {
  return input
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(token|password|secret|apiKey|api_key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
}

export function assertNoControlChars(value: string, label: string): string {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      throw new TeamError('INVALID_INPUT', `${label} contains disallowed control characters`)
    }
  }
  return value
}

export function assertNonEmptyBounded(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw new TeamError('INVALID_INPUT', `${label} must be a string`)
  }
  assertNoControlChars(value, label)
  const trimmed = value.trim()
  if (!trimmed) {
    throw new TeamError('INVALID_INPUT', `${label} must not be empty`)
  }
  if (trimmed.length > maxChars) {
    throw new TeamError('INVALID_INPUT', `${label} exceeds max length (${maxChars})`)
  }
  return trimmed
}

export function assertPromptBounded(value: unknown, label = 'prompt'): string {
  if (typeof value !== 'string') {
    throw new TeamError('INVALID_INPUT', `${label} must be a string`)
  }
  assertNoControlChars(value, label)
  const trimmed = value.trim()
  if (!trimmed) {
    throw new TeamError('INVALID_INPUT', `${label} must not be empty`)
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_PROMPT_BYTES) {
    throw new TeamError('INVALID_INPUT', `${label} exceeds ${MAX_PROMPT_BYTES} bytes limit`)
  }
  return trimmed
}

export function validateBounds(partial?: Partial<TeamExecutionBounds>): TeamExecutionBounds {
  const bounds: TeamExecutionBounds = {
    maxDepth: partial?.maxDepth ?? 3,
    maxAttempts: partial?.maxAttempts ?? 2,
    maxTokens: partial?.maxTokens ?? 50_000,
    maxDurationMs: partial?.maxDurationMs ?? 300_000,
    maxConcurrentTasks: partial?.maxConcurrentTasks ?? 3,
  }
  if (!Number.isInteger(bounds.maxDepth) || bounds.maxDepth < 0 || bounds.maxDepth > MAX_DEPTH_LIMIT) {
    throw new TeamError('INVALID_BOUNDS', `maxDepth must be 0..${MAX_DEPTH_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxAttempts) ||
    bounds.maxAttempts < 1 ||
    bounds.maxAttempts > MAX_ATTEMPTS_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxAttempts must be 1..${MAX_ATTEMPTS_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxTokens) ||
    bounds.maxTokens < 100 ||
    bounds.maxTokens > MAX_TOKENS_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxTokens must be 100..${MAX_TOKENS_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxDurationMs) ||
    bounds.maxDurationMs < 1000 ||
    bounds.maxDurationMs > MAX_DURATION_MS_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxDurationMs must be 1000..${MAX_DURATION_MS_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxConcurrentTasks) ||
    bounds.maxConcurrentTasks < 1 ||
    bounds.maxConcurrentTasks > MAX_CONCURRENT_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxConcurrentTasks must be 1..${MAX_CONCURRENT_LIMIT}`)
  }
  return bounds
}

export function validateCreateTeamInput(input: CreateTeamInput) {
  const name = assertNonEmptyBounded(input.name, 'name', MAX_TEAM_NAME_CHARS)
  const descriptionRaw = input.description ?? ''
  if (typeof descriptionRaw !== 'string') {
    throw new TeamError('INVALID_INPUT', 'description must be a string')
  }
  assertNoControlChars(descriptionRaw, 'description')
  if (descriptionRaw.length > MAX_TEAM_DESC_CHARS) {
    throw new TeamError('INVALID_INPUT', `description exceeds ${MAX_TEAM_DESC_CHARS} chars`)
  }
  const ownerId = assertNonEmptyBounded(input.ownerId, 'ownerId', 128)
  const leadBotId = assertNonEmptyBounded(input.leadBotId, 'leadBotId', 128)
  if (!Array.isArray(input.memberBotIds) || input.memberBotIds.length === 0) {
    throw new TeamError('INVALID_INPUT', 'memberBotIds must be a non-empty array')
  }
  const dedup = new Set<string>([leadBotId])
  for (const m of input.memberBotIds) {
    dedup.add(assertNonEmptyBounded(m, 'memberBotId', 128))
  }
  if (dedup.size > MAX_TEAM_MEMBERS) {
    throw new TeamError('INVALID_INPUT', `Team cannot exceed ${MAX_TEAM_MEMBERS} members`)
  }

  return {
    name,
    description: descriptionRaw.trim(),
    ownerId,
    leadBotId,
    memberBotIds: [...dedup],
    bounds: validateBounds(input.bounds),
  }
}

export function assertTeamOwner(expectedOwnerId: string, actualOwnerId: string): void {
  if (expectedOwnerId !== actualOwnerId) {
    throw new TeamError('SCOPE_FORBIDDEN', 'Team or task access denied outside owner scope')
  }
}
