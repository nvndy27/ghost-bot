import type {
  ConcurrencyPolicy,
  CreateRoutineInput,
  MissedRunPolicy,
  RetryPolicy,
  RoutineRecord,
  RoutineScope,
  RoutineTaskDefinition,
  TriggerConfig,
} from '../contracts/types.ts'
import type { RoutineRepository } from '../repository/routine-repository.ts'
import {
  assertNoControlChars,
  SchedulerError,
  validateCreateRoutineInput,
} from '../security/validation.ts'

export const EXPORT_SCHEMA_ID = 'ghost-bot.scheduler.routines.v1'
export const EXPORT_SCHEMA_VERSION = 1
export const MAX_IMPORT_BYTES = 256 * 1024
export const MAX_IMPORT_ROUTINES = 50

export type ImportConflictPolicy = 'skip' | 'rename' | 'overwrite'

export interface PortableRoutineDefinition {
  name: string
  description: string
  trigger: TriggerConfig
  timezone: string
  task: RoutineTaskDefinition
  missedRunPolicy: MissedRunPolicy
  maxCatchUpRuns: number
  concurrencyPolicy: ConcurrencyPolicy
  maxConcurrentRuns: number
  retryPolicy: RetryPolicy
  expiresAt: string | null
}

export interface PortableRoutineBundle {
  schema: typeof EXPORT_SCHEMA_ID
  schemaVersion: typeof EXPORT_SCHEMA_VERSION
  exportedAt: string
  routines: PortableRoutineDefinition[]
}

const TOP_LEVEL_KEYS = new Set(['schema', 'schemaVersion', 'exportedAt', 'routines'])
const ROUTINE_KEYS = new Set([
  'name',
  'description',
  'trigger',
  'timezone',
  'task',
  'missedRunPolicy',
  'maxCatchUpRuns',
  'concurrencyPolicy',
  'maxConcurrentRuns',
  'retryPolicy',
  'expiresAt',
])

function assertNoCredentialSecrets(text: string, label: string): void {
  if (
    /Bearer\s+[A-Za-z0-9._-]+/i.test(text) ||
    /sk-[A-Za-z0-9_-]{10,}/.test(text) ||
    /(api_key|apiKey|password|secret|token)\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/i.test(text)
  ) {
    throw new SchedulerError(
      'CREDENTIAL_EXPOSURE_BLOCKED',
      `${label} appears to contain credential material and cannot be exported/imported`,
    )
  }
}

export function exportRoutines(
  repository: RoutineRepository,
  routineIds: string[],
  scope: RoutineScope,
  nowMs = Date.now(),
): PortableRoutineBundle {
  const routines: PortableRoutineDefinition[] = []
  for (const id of routineIds) {
    const r = repository.getById(id, scope)
    assertNoCredentialSecrets(r.task.prompt, 'task.prompt')
    assertNoCredentialSecrets(r.description, 'description')
    routines.push({
      name: r.name,
      description: r.description,
      trigger: r.trigger,
      timezone: r.timezone,
      task: r.task,
      missedRunPolicy: r.missedRunPolicy,
      maxCatchUpRuns: r.maxCatchUpRuns,
      concurrencyPolicy: r.concurrencyPolicy,
      maxConcurrentRuns: r.maxConcurrentRuns,
      retryPolicy: r.retryPolicy,
      expiresAt: r.expiresAt,
    })
  }
  return {
    schema: EXPORT_SCHEMA_ID,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    routines,
  }
}

export interface ImportValidationPreview {
  valid: boolean
  totalParsed: number
  wouldCreate: number
  wouldSkip: number
  wouldRename: number
  wouldOverwrite: number
  conflicts: string[]
  validatedInputs: CreateRoutineInput[]
}

function parseAndValidateBundle(
  rawJson: string,
  receivingScope: RoutineScope,
): PortableRoutineDefinition[] {
  if (typeof rawJson !== 'string') {
    throw new SchedulerError('INVALID_IMPORT', 'Import payload must be a JSON string')
  }
  if (Buffer.byteLength(rawJson, 'utf8') > MAX_IMPORT_BYTES) {
    throw new SchedulerError(
      'INVALID_IMPORT',
      `Import payload exceeds ${MAX_IMPORT_BYTES} bytes limit`,
    )
  }
  assertNoControlChars(rawJson, 'import payload')

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    throw new SchedulerError('INVALID_IMPORT', 'Import payload is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SchedulerError('INVALID_IMPORT', 'Import payload must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      throw new SchedulerError('INVALID_IMPORT', `Unknown top-level field "${k}"`)
    }
  }
  if (obj.schema !== EXPORT_SCHEMA_ID || obj.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new SchedulerError('UNSUPPORTED_SCHEMA_VERSION', 'Unsupported routine bundle schema/version')
  }
  if (!Array.isArray(obj.routines) || obj.routines.length === 0) {
    throw new SchedulerError('INVALID_IMPORT', 'Bundle routines must be a non-empty array')
  }
  if (obj.routines.length > MAX_IMPORT_ROUTINES) {
    throw new SchedulerError(
      'INVALID_IMPORT',
      `Bundle exceeds maximum ${MAX_IMPORT_ROUTINES} routines`,
    )
  }

  return obj.routines.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SchedulerError('INVALID_IMPORT', `Routine[${idx}] must be an object`)
    }
    const r = item as Record<string, unknown>
    for (const k of Object.keys(r)) {
      if (!ROUTINE_KEYS.has(k)) {
        throw new SchedulerError(
          'INVALID_IMPORT',
          `Unknown or forbidden field "${k}" in routine[${idx}]`,
        )
      }
    }

    const clean = validateCreateRoutineInput({
      name: r.name as string,
      description: typeof r.description === 'string' ? r.description : '',
      ownerId: receivingScope.ownerId,
      botId: receivingScope.botId,
      ownership: 'ghost-bot',
      trigger: r.trigger as TriggerConfig,
      timezone: r.timezone as string,
      task: r.task as RoutineTaskDefinition,
      enabled: false,
      missedRunPolicy: r.missedRunPolicy as MissedRunPolicy,
      maxCatchUpRuns: r.maxCatchUpRuns as number,
      concurrencyPolicy: r.concurrencyPolicy as ConcurrencyPolicy,
      maxConcurrentRuns: r.maxConcurrentRuns as number,
      retryPolicy: r.retryPolicy as RetryPolicy,
      expiresAt: r.expiresAt as string | null | undefined,
    })

    assertNoCredentialSecrets(clean.task.prompt, `routine[${idx}].task.prompt`)
    assertNoCredentialSecrets(clean.description, `routine[${idx}].description`)
    if (clean.task.metadata) {
      for (const [mk, mv] of Object.entries(clean.task.metadata)) {
        assertNoCredentialSecrets(mv, `routine[${idx}].task.metadata["${mk}"]`)
      }
    }

    return {
      name: clean.name,
      description: clean.description,
      trigger: clean.trigger,
      timezone: clean.timezone,
      task: clean.task,
      missedRunPolicy: clean.missedRunPolicy,
      maxCatchUpRuns: clean.maxCatchUpRuns,
      concurrencyPolicy: clean.concurrencyPolicy,
      maxConcurrentRuns: clean.maxConcurrentRuns,
      retryPolicy: clean.retryPolicy,
      expiresAt: clean.expiresAt,
    }
  })
}

export function previewImportRoutines(
  rawJson: string,
  receivingScope: RoutineScope,
  repository: RoutineRepository,
  conflictPolicy: ImportConflictPolicy = 'skip',
): ImportValidationPreview {
  const defs = parseAndValidateBundle(rawJson, receivingScope)
  const existing = repository.list(receivingScope, { limit: 100, includeArchived: false }).routines
  const existingNames = new Set(existing.map((r) => r.name))

  let wouldCreate = 0
  let wouldSkip = 0
  let wouldRename = 0
  let wouldOverwrite = 0
  const conflicts: string[] = []
  const validatedInputs: CreateRoutineInput[] = []

  for (const def of defs) {
    const hasConflict = existingNames.has(def.name)
    if (hasConflict) {
      conflicts.push(def.name)
      if (conflictPolicy === 'skip') {
        wouldSkip += 1
        continue
      }
      if (conflictPolicy === 'rename') {
        wouldRename += 1
      } else {
        wouldOverwrite += 1
      }
    } else {
      wouldCreate += 1
    }
    validatedInputs.push({
      ...def,
      ownerId: receivingScope.ownerId,
      botId: receivingScope.botId,
      ownership: 'ghost-bot',
      enabled: false,
    })
  }

  return {
    valid: true,
    totalParsed: defs.length,
    wouldCreate,
    wouldSkip,
    wouldRename,
    wouldOverwrite,
    conflicts,
    validatedInputs,
  }
}

export function commitImportRoutines(
  rawJson: string,
  receivingScope: RoutineScope,
  repository: RoutineRepository,
  conflictPolicy: ImportConflictPolicy = 'skip',
  nowMs = Date.now(),
): { imported: RoutineRecord[]; skipped: number } {
  const defs = parseAndValidateBundle(rawJson, receivingScope)
  const db = repository.getDatabase()

  return db.transaction(() => {
    const existing = repository.list(receivingScope, { limit: 100, includeArchived: false }).routines
    const byName = new Map(existing.map((r) => [r.name, r]))
    const imported: RoutineRecord[] = []
    let skipped = 0

    for (const def of defs) {
      const existingMatch = byName.get(def.name)
      if (existingMatch) {
        if (conflictPolicy === 'skip') {
          skipped += 1
          continue
        }
        if (conflictPolicy === 'overwrite') {
          repository.disable(existingMatch.id, receivingScope, nowMs)
          const updated = repository.update(
            existingMatch.id,
            receivingScope,
            {
              description: def.description,
              trigger: def.trigger,
              timezone: def.timezone,
              task: def.task,
              missedRunPolicy: def.missedRunPolicy,
              maxCatchUpRuns: def.maxCatchUpRuns,
              concurrencyPolicy: def.concurrencyPolicy,
              maxConcurrentRuns: def.maxConcurrentRuns,
              retryPolicy: def.retryPolicy,
              expiresAt: def.expiresAt,
            },
            nowMs,
          )
          imported.push(updated)
          continue
        }
        // rename
        let suffix = 2
        let candidate = `${def.name} (${suffix})`
        while (byName.has(candidate)) {
          suffix += 1
          candidate = `${def.name} (${suffix})`
        }
        const created = repository.create(
          {
            ...def,
            name: candidate,
            ownerId: receivingScope.ownerId,
            botId: receivingScope.botId,
            ownership: 'ghost-bot',
            enabled: false,
          },
          nowMs,
        )
        byName.set(created.name, created)
        imported.push(created)
        continue
      }

      const created = repository.create(
        {
          ...def,
          ownerId: receivingScope.ownerId,
          botId: receivingScope.botId,
          ownership: 'ghost-bot',
          enabled: false,
        },
        nowMs,
      )
      byName.set(created.name, created)
      imported.push(created)
    }

    return { imported, skipped }
  })
}
