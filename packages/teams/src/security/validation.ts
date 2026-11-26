import type {
  CreateTeamInput,
  PlannedTeamTaskInput,
  TeamExecutionBounds,
  TeamRecord,
  TeamTaskPlan,
} from '../contracts/types.ts'

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
export const MAX_TASKS_PER_RUN_LIMIT = 100
export const MAX_MESSAGES_LIMIT = 2000
export const MAX_RESULT_BYTES_LIMIT = 512 * 1024

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
    maxTasksPerRun: partial?.maxTasksPerRun ?? 25,
    maxMessages: partial?.maxMessages ?? 200,
    maxResultBytes: partial?.maxResultBytes ?? 64 * 1024,
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
  if (
    !Number.isInteger(bounds.maxTasksPerRun) ||
    bounds.maxTasksPerRun < 1 ||
    bounds.maxTasksPerRun > MAX_TASKS_PER_RUN_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxTasksPerRun must be 1..${MAX_TASKS_PER_RUN_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxMessages) ||
    bounds.maxMessages < 1 ||
    bounds.maxMessages > MAX_MESSAGES_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxMessages must be 1..${MAX_MESSAGES_LIMIT}`)
  }
  if (
    !Number.isInteger(bounds.maxResultBytes) ||
    bounds.maxResultBytes < 1024 ||
    bounds.maxResultBytes > MAX_RESULT_BYTES_LIMIT
  ) {
    throw new TeamError('INVALID_BOUNDS', `maxResultBytes must be 1024..${MAX_RESULT_BYTES_LIMIT}`)
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

export function truncateUtf8ToByteLimit(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const safe = redactTeamSecrets(value)
  if (Buffer.byteLength(safe, 'utf8') <= maxBytes) {
    return { text: safe, truncated: false }
  }
  let end = safe.length
  while (end > 0 && Buffer.byteLength(safe.slice(0, end), 'utf8') > maxBytes) {
    end = Math.floor(end * 0.85)
  }
  return { text: safe.slice(0, end), truncated: true }
}

export interface ValidatedPlanTask extends PlannedTeamTaskInput {
  planKey: string
  assignedBotId: string
  prompt: string
  dependsOn: string[]
  depth: number
}

export function validateTaskPlan(
  plan: TeamTaskPlan,
  team: TeamRecord,
): { summary: string; tasks: ValidatedPlanTask[] } {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks)) {
    throw new TeamError('INVALID_PLAN', 'Task plan must include a tasks array')
  }
  const summary = assertNonEmptyBounded(plan.summary, 'plan.summary', MAX_TEAM_DESC_CHARS)
  if (plan.tasks.length === 0) {
    throw new TeamError('INVALID_PLAN', 'Task plan must contain at least one task')
  }
  // +1 for the Chief of Staff root task in the run
  if (plan.tasks.length + 1 > team.bounds.maxTasksPerRun) {
    throw new TeamError(
      'PLAN_TOO_LARGE',
      `Task plan (${plan.tasks.length} tasks + root) exceeds maxTasksPerRun (${team.bounds.maxTasksPerRun})`,
    )
  }

  const byKey = new Map<string, ValidatedPlanTask>()
  for (const raw of plan.tasks) {
    const planKey = assertNonEmptyBounded(raw.planKey, 'planKey', 64)
    if (byKey.has(planKey)) {
      throw new TeamError('DUPLICATE_PLAN_KEY', `Duplicate task planKey "${planKey}"`)
    }
    const assignedBotId = assertNonEmptyBounded(raw.assignedBotId, 'assignedBotId', 128)
    if (!team.memberBotIds.includes(assignedBotId)) {
      throw new TeamError(
        'NON_MEMBER_BOT',
        `Planned task "${planKey}" assigned to non-member bot "${assignedBotId}"`,
      )
    }
    const prompt = assertPromptBounded(raw.prompt, `task[${planKey}].prompt`)
    const deps = Array.isArray(raw.dependsOn)
      ? [...new Set(raw.dependsOn.map((d) => assertNonEmptyBounded(d, 'dependsOn', 64)))]
      : []

    if (deps.includes(planKey)) {
      throw new TeamError('SELF_DEPENDENCY', `Task "${planKey}" cannot depend on itself`)
    }
    byKey.set(planKey, {
      ...raw,
      planKey,
      assignedBotId,
      prompt,
      dependsOn: deps,
      depth: 1,
    })
  }

  for (const task of byKey.values()) {
    for (const depKey of task.dependsOn) {
      if (!byKey.has(depKey)) {
        throw new TeamError(
          'MISSING_DEPENDENCY',
          `Task "${task.planKey}" references missing dependency "${depKey}"`,
        )
      }
    }
  }

  // Detect cycles and compute topological dependency depth (root = 0, independent planned = 1)
  const visitState = new Map<string, 'visiting' | 'visited'>()
  const computedDepth = new Map<string, number>()

  function dfs(key: string): number {
    const state = visitState.get(key)
    if (state === 'visiting') {
      throw new TeamError('CIRCULAR_DEPENDENCY', `Circular dependency detected at "${key}"`)
    }
    if (state === 'visited') {
      return computedDepth.get(key)!
    }
    visitState.set(key, 'visiting')
    const node = byKey.get(key)!
    let maxDepDepth = 0
    for (const depKey of node.dependsOn) {
      maxDepDepth = Math.max(maxDepDepth, dfs(depKey))
    }
    const depth = node.dependsOn.length === 0 ? 1 : maxDepDepth + 1
    if (depth > team.bounds.maxDepth) {
      throw new TeamError(
        'MAX_DEPTH_EXCEEDED',
        `Planned task "${key}" dependency depth ${depth} exceeds maxDepth (${team.bounds.maxDepth})`,
      )
    }
    visitState.set(key, 'visited')
    computedDepth.set(key, depth)
    node.depth = depth
    return depth
  }

  for (const key of byKey.keys()) {
    dfs(key)
  }

  return { summary, tasks: [...byKey.values()] }
}
