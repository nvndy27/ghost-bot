import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { SchedulerEngine } from '../src/engine/scheduler-engine.ts'
import { evaluateNotificationPolicy, isWithinQuietHours } from '../src/notifications/policy.ts'
import { NotificationRepository } from '../src/notifications/repository.ts'
import { commitImportRoutines, exportRoutines } from '../src/portability/export-import.ts'
import { RoutineApprovalCoordinator } from '../src/queue/approval-coordinator.ts'
import { ExecutionQueue } from '../src/queue/execution-queue.ts'
import { RoutineRepository } from '../src/repository/routine-repository.ts'
import { openSchedulerDatabase } from '../src/repository/sqlite-store.ts'

test('5A.4 hardening: dedup watermark, unknown dispatch outcome, and import overwrite safety', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a4-h-'))
  const scope = { ownerId: 'u1', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db)
    const nowMs = Date.parse('2026-01-01T00:00:00.000Z')
    const engine = new SchedulerEngine({ repository: repo, queue, clock: { nowMs: () => nowMs } })

    const r = repo.create(
      {
        name: 'Watermark Job',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T00:00:00.000Z' },
        task: { prompt: 'Run', idempotent: true },
      },
      nowMs,
    )

    // Enqueue with dedup expiry, complete, prune history, prune expired dedup -> watermark blocks replay
    const enq = queue.enqueueOccurrence(r, '2026-01-01T00:00:00.000Z', nowMs, {
      dedupExpiresAt: '2026-01-01T00:05:00.000Z',
    })
    const c = queue.claimNext('w1', 10_000, nowMs)
    queue.markRunning(c!.id, 'w1', nowMs)
    queue.completeTask(c!.id, 'w1', nowMs + 100)
    queue.pruneCompletedHistory({ olderThanIso: '2026-01-01T00:01:00.000Z' })
    assert.equal(queue.pruneExpiredDedup({ nowIso: '2026-01-01T00:06:00.000Z' }), 1)
    assert.throws(
      () => queue.enqueueOccurrence(r, '2026-01-01T00:00:00.000Z', nowMs + 400_000),
      { code: 'STALE_OCCURRENCE_BEFORE_WATERMARK' },
    )

    // Unknown dispatcher outcome -> interrupted + uncertainExecution = true
    queue.enqueueOccurrence(r, '2026-01-01T00:02:00.000Z', nowMs + 120_000)
    const unknownRes = await engine.dispatchNext(
      {
        async dispatch() {
          return { status: 'unknown', reason: 'Transport dropped after submit' }
        },
      },
      'w2',
    )
    assert.equal(unknownRes?.status, 'interrupted')
    assert.equal(unknownRes?.uncertainExecution, true)
    assert.equal(unknownRes?.errorCode, 'DISPATCH_OUTCOME_UNKNOWN')

    // Import overwrite blocked when uncertain task exists on routine
    const bundle = JSON.stringify(exportRoutines(repo, [r.id], scope, nowMs))
    assert.throws(
      () => commitImportRoutines(bundle, scope, repo, 'overwrite', nowMs),
      { code: 'IMPORT_CONFLICT_ACTIVE_EXECUTION' },
    )
    assert.equal(enq.created, true)
    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('5A.4 notifications: scope isolation, deduplication, quiet hours across midnight/DST, capacity, and dismissal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a4-ntf-'))
  const scope = { ownerId: 'u1', botId: 'chief' }
  const otherScope = { ownerId: 'u2', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const ntfRepo = new NotificationRepository(db, 3)
    const nowMs = Date.parse('2026-03-08T07:30:00.000Z') // 03:30 EDT (DST spring-forward night)

    const r = repo.create(
      {
        name: 'Notify Job',
        ...scope,
        timezone: 'America/New_York',
        trigger: { kind: 'daily', hour: 9, minute: 0 },
        task: { prompt: 'Run', idempotent: true },
      },
      nowMs,
    )

    // Overnight quiet hours 22:00 -> 07:00 America/New_York
    const policy = {
      enabledCategories: ['routine.completed', 'approval.required'] as (
        | 'routine.completed'
        | 'approval.required'
      )[],
      quietHours: {
        enabled: true,
        timezone: 'America/New_York',
        startHour: 22,
        startMinute: 0,
        endHour: 7,
        endMinute: 0,
      },
      maxPerHour: 10,
    }
    assert.equal(isWithinQuietHours(policy.quietHours, nowMs), true)

    const decCrit = evaluateNotificationPolicy(policy, 'approval.required', 'critical', nowMs, 0)
    assert.equal(decCrit.persistInApp, true)
    assert.equal(decCrit.deliveryStatus, 'deferred_quiet_hours')
    assert.equal(decCrit.deliverExternallyNow, false)

    // Create + deduplication + secret redaction
    const n1 = ntfRepo.create(
      {
        routineId: r.id,
        routineRevision: r.revision,
        scope,
        category: 'approval.required',
        severity: 'critical',
        dedupKey: 'k-ntf-1',
        summary: 'Needs approval Bearer supersecret123',
        deliveryStatus: decCrit.deliveryStatus,
      },
      nowMs,
    )
    assert.equal(n1.created, true)
    assert.doesNotMatch(n1.notification.summary, /supersecret123/)
    const n1Dup = ntfRepo.create(
      {
        routineId: r.id,
        routineRevision: r.revision,
        scope,
        category: 'approval.required',
        severity: 'critical',
        dedupKey: 'k-ntf-1',
        summary: 'dup',
      },
      nowMs,
    )
    assert.equal(n1Dup.created, false)

    // Scope isolation & unread/read/dismiss
    assert.equal(ntfRepo.countUnread(scope), 1)
    assert.equal(ntfRepo.countUnread(otherScope), 0)
    assert.throws(() => ntfRepo.markAsRead(n1.notification.id, otherScope), {
      code: 'SCOPE_FORBIDDEN',
    })
    ntfRepo.markSelectedAsRead([n1.notification.id], scope, nowMs + 100)
    assert.equal(ntfRepo.countUnread(scope), 0)
    ntfRepo.dismiss(n1.notification.id, scope, nowMs + 200)
    assert.equal(ntfRepo.list(scope, { includeDismissed: false }).total, 0)
    assert.equal(ntfRepo.list(scope, { includeDismissed: true }).total, 1)

    // Capacity limit (max = 3)
    ntfRepo.create(
      {
        routineId: r.id,
        routineRevision: 1,
        scope,
        category: 'routine.completed',
        severity: 'info',
        dedupKey: 'k-ntf-2',
        summary: 'ok 2',
      },
      nowMs,
    )
    ntfRepo.create(
      {
        routineId: r.id,
        routineRevision: 1,
        scope,
        category: 'routine.completed',
        severity: 'info',
        dedupKey: 'k-ntf-3',
        summary: 'ok 3',
      },
      nowMs,
    )
    assert.throws(
      () =>
        ntfRepo.create(
          {
            routineId: r.id,
            routineRevision: 1,
            scope,
            category: 'routine.completed',
            severity: 'info',
            dedupKey: 'k-ntf-4',
            summary: 'overflow',
          },
          nowMs,
        ),
      { code: 'NOTIFICATION_CAPACITY_EXCEEDED' },
    )

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('5A.4 approval coordination: bind, denial, expiration, delivery_unknown, stale event, continuation, and restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-5a4-appr-'))
  const scope = { ownerId: 'u1', botId: 'chief' }

  try {
    const db = openSchedulerDatabase(dir)
    const repo = new RoutineRepository(db)
    const queue = new ExecutionQueue(db)
    const ntfRepo = new NotificationRepository(db)
    const coordinator = new RoutineApprovalCoordinator(db, { notifications: ntfRepo })
    const nowMs = Date.parse('2026-01-01T10:00:00.000Z')

    const r = repo.create(
      {
        name: 'Approval Routine',
        ...scope,
        timezone: 'UTC',
        trigger: { kind: 'interval', intervalMs: 60_000, anchorAt: '2026-01-01T10:00:00.000Z' },
        task: { prompt: 'Edit file', idempotent: true },
        concurrencyPolicy: 'allow-bounded',
        maxConcurrentRuns: 5,
      },
      nowMs,
    )

    // 1. Bind & approved_for_continuation continues SAME taskId
    const t1 = queue.enqueueOccurrence(r, '2026-01-01T10:00:00.000Z', nowMs).task
    queue.claimNext('w1', 30_000, nowMs)
    queue.markRunning(t1.id, 'w1', nowMs)
    const awaiting1 = coordinator.bindApprovalRequest(
      {
        routineId: r.id,
        routineRevision: r.revision,
        occurrenceKey: t1.occurrenceKey,
        taskId: t1.id,
        scope,
        daemonRunId: 'run-d-1',
        daemonApprovalId: 'appr-1',
        expiresAt: '2026-01-01T10:05:00.000Z',
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'Write notes.md',
      },
      nowMs,
    )
    assert.equal(awaiting1.status, 'awaiting_approval')
    assert.equal(ntfRepo.countUnread(scope), 1)

    // Stale approval event ignored
    const stale = coordinator.applyApprovalEvent(
      {
        taskId: t1.id,
        scope,
        daemonRunId: 'run-d-1',
        daemonApprovalId: 'appr-wrong',
        routineRevision: r.revision,
        kind: 'denied',
      },
      nowMs + 1000,
    )
    assert.equal(stale.applied, false)
    assert.equal(stale.reason, 'STALE_APPROVAL_EVENT')

    const cont = coordinator.applyApprovalEvent(
      {
        taskId: t1.id,
        scope,
        daemonRunId: 'run-d-1',
        daemonApprovalId: 'appr-1',
        routineRevision: r.revision,
        kind: 'approved_for_continuation',
      },
      nowMs + 2000,
    )
    assert.equal(cont.applied, true)
    assert.equal(cont.approvalState, 'authorized.continuation')
    assert.equal(cont.task.id, t1.id)
    assert.equal(cont.task.status, 'running')
    queue.completeTask(t1.id, 'w1', nowMs + 3000)

    // 2. Denied, provider_delivery_unknown, expiration, and restart while awaiting approval
    const t2 = queue.enqueueOccurrence(r, '2026-01-01T10:01:00.000Z', nowMs).task
    queue.claimNext('w2', 30_000, nowMs)
    coordinator.bindApprovalRequest(
      {
        routineId: r.id,
        routineRevision: r.revision,
        occurrenceKey: t2.occurrenceKey,
        taskId: t2.id,
        scope,
        daemonRunId: 'run-d-2',
        daemonApprovalId: 'appr-2',
        expiresAt: '2026-01-01T10:05:00.000Z',
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'Run test',
      },
      nowMs,
    )
    const denied = coordinator.applyApprovalEvent(
      {
        taskId: t2.id,
        scope,
        daemonRunId: 'run-d-2',
        daemonApprovalId: 'appr-2',
        routineRevision: r.revision,
        kind: 'denied',
      },
      nowMs + 1000,
    )
    assert.equal(denied.task.status, 'failed')
    assert.equal(denied.task.errorCode, 'APPROVAL_DENIED')

    const t3 = queue.enqueueOccurrence(r, '2026-01-01T10:02:00.000Z', nowMs).task
    queue.claimNext('w3', 30_000, nowMs)
    coordinator.bindApprovalRequest(
      {
        routineId: r.id,
        routineRevision: r.revision,
        occurrenceKey: t3.occurrenceKey,
        taskId: t3.id,
        scope,
        daemonRunId: 'run-d-3',
        daemonApprovalId: 'appr-3',
        expiresAt: '2026-01-01T10:05:00.000Z',
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'Edit file',
      },
      nowMs,
    )
    const delivUnknown = coordinator.applyApprovalEvent(
      {
        taskId: t3.id,
        scope,
        daemonRunId: 'run-d-3',
        daemonApprovalId: 'appr-3',
        routineRevision: r.revision,
        kind: 'provider_delivery_unknown',
      },
      nowMs + 1000,
    )
    assert.equal(delivUnknown.task.status, 'interrupted')
    assert.equal(delivUnknown.task.uncertainExecution, true)

    const t4 = queue.enqueueOccurrence(r, '2026-01-01T10:03:00.000Z', nowMs).task
    queue.claimNext('w4', 30_000, nowMs)
    coordinator.bindApprovalRequest(
      {
        routineId: r.id,
        routineRevision: r.revision,
        occurrenceKey: t4.occurrenceKey,
        taskId: t4.id,
        scope,
        daemonRunId: 'run-d-4',
        daemonApprovalId: 'appr-4',
        expiresAt: '2026-01-01T10:04:00.000Z',
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'Expire test',
      },
      nowMs,
    )
    assert.equal(coordinator.expireAwaitingApprovals(Date.parse('2026-01-01T10:04:01.000Z')), 1)
    assert.equal(queue.getTask(t4.id, scope).status, 'expired')

    // Restart while awaiting approval -> interrupted + uncertainExecution = true
    const t5 = queue.enqueueOccurrence(r, '2026-01-01T10:04:00.000Z', nowMs).task
    queue.claimNext('w5', 30_000, nowMs)
    coordinator.bindApprovalRequest(
      {
        routineId: r.id,
        routineRevision: r.revision,
        occurrenceKey: t5.occurrenceKey,
        taskId: t5.id,
        scope,
        daemonRunId: 'run-d-5',
        daemonApprovalId: 'appr-5',
        expiresAt: '2026-01-01T10:10:00.000Z',
        requirePolicyRevalidation: true,
        sanitizedActionSummary: 'Crash test',
      },
      nowMs,
    )
    assert.equal(queue.reconcileOnRestart(nowMs + 5000), 1)
    assert.equal(queue.getTask(t5.id, scope).status, 'interrupted')
    assert.equal(queue.getTask(t5.id, scope).uncertainExecution, true)

    db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('5A.4 schema upgrade: upgrades Phase 5A.1 v1 SQLite database to 0004 without data loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ghost-sched-upgrade-'))
  try {
    const dbPath = join(dir, 'scheduler.sqlite')
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE scheduler_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE scheduler_routines (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, trigger_json TEXT NOT NULL,
        timezone TEXT NOT NULL, task_json TEXT NOT NULL, enabled INTEGER NOT NULL,
        archived_at TEXT, missed_run_policy TEXT NOT NULL, max_catch_up_runs INTEGER NOT NULL,
        concurrency_policy TEXT NOT NULL, max_concurrent_runs INTEGER NOT NULL,
        retry_policy_json TEXT NOT NULL, expires_at TEXT, next_run_at TEXT,
        last_run_at TEXT, last_evaluated_at TEXT, last_task_status TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE scheduler_tasks (
        id TEXT PRIMARY KEY, routine_id TEXT NOT NULL REFERENCES scheduler_routines(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, bot_id TEXT NOT NULL, occurrence_key TEXT NOT NULL UNIQUE,
        scheduled_for TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL, claim_owner TEXT, claim_lease_expires_at TEXT,
        uncertain_execution INTEGER NOT NULL DEFAULT 0, approval_required INTEGER NOT NULL DEFAULT 0,
        task_snapshot_json TEXT NOT NULL, error_code TEXT, error_message TEXT,
        started_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO scheduler_schema_migrations VALUES (1, '0001_scheduler_foundation', '2026-01-01T00:00:00.000Z');
      INSERT INTO scheduler_routines VALUES (
        'rtn-v1', 'Legacy v1 Routine', 'Preserved', 'u1', 'chief',
        '{"kind":"daily","hour":9,"minute":0,"second":0}', 'UTC',
        '{"prompt":"Hello","idempotent":true}', 1, NULL, 'skip', 3, 'forbid', 1,
        '{"maxAttempts":1,"backoffMs":1000,"retryNonIdempotent":false}', NULL,
        '2026-01-01T09:00:00.000Z', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `)
    raw.close()

    const upgraded = openSchedulerDatabase(dir)
    const versions = (
      upgraded.sqlite.prepare(`SELECT version FROM scheduler_schema_migrations ORDER BY version`).all() as Array<{
        version: number
      }>
    ).map((r) => Number(r.version))
    assert.deepEqual(versions, [1, 2, 3, 4])

    const repo = new RoutineRepository(upgraded)
    const legacy = repo.getById('rtn-v1', { ownerId: 'u1', botId: 'chief' })
    assert.equal(legacy.name, 'Legacy v1 Routine')
    assert.equal(legacy.revision, 1)
    assert.equal(legacy.ownership, 'ghost-bot')
    upgraded.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
