import { createHash } from 'node:crypto'
import { TeamMemberRoutingTupleSchema } from '@ghost-bot/shared-types/ipc'
import { z } from 'zod'
import type { DatabaseHandle } from '../db/client.ts'
import { LOCAL_USER_ID } from '../memory/service.ts'

export const PRIVATE_TASK_META_PREFIX = 'teams.private-task-meta:'

const taskMetaSchema = z.object({
  teamId: z.string().min(1),
  teamName: z.string(),
  teamRunId: z.string().min(1),
  taskId: z.string().min(1),
  assignedBotId: z.string().min(1),
  objective: z.string(),
  sessionId: z.string().min(1),
  routing: TeamMemberRoutingTupleSchema,
  revision: z.string().min(1).optional(),
  createdAt: z.string(),
})

export type StoredTaskMeta = z.infer<typeof taskMetaSchema>

export function privateTaskSessionIdentity(meta: Pick<StoredTaskMeta, 'teamId' | 'teamRunId' | 'assignedBotId' | 'routing' | 'revision'>): string {
  return createHash('sha256').update(JSON.stringify([
    meta.teamId, meta.teamRunId, meta.assignedBotId, meta.routing, meta.revision,
  ])).digest('hex')
}

export function readPrivateTaskMeta(db: DatabaseHandle, teamRunId: string): StoredTaskMeta | null {
  const row = db.sqlite.prepare('SELECT value_json FROM settings WHERE key = ?')
    .get(PRIVATE_TASK_META_PREFIX + teamRunId) as { value_json: string } | undefined
  if (!row) return null
  try {
    const meta = taskMetaSchema.parse(JSON.parse(row.value_json))
    if (meta.teamRunId !== teamRunId) return null
    const bound = db.sqlite.prepare(`
      SELECT 1 FROM team_runs r
      JOIN teams g ON g.id = r.team_id AND g.owner_id = r.owner_id AND g.archived_at IS NULL
      JOIN team_tasks t ON t.team_run_id = r.id AND t.team_id = r.team_id AND t.owner_id = r.owner_id
      JOIN sessions s ON s.id = ? AND s.agent_id = t.assigned_bot_id
        AND s.runtime_id = ? AND s.account_id = ?
      JOIN settings m ON m.key = 'teams.child-session:' || s.id
      WHERE r.id = ? AND r.team_id = ? AND r.owner_id = ? AND r.idempotency_key LIKE 'private-task:%'
        AND r.goal = ? AND t.id = ? AND t.assigned_bot_id = ? AND t.plan_key = 'delegated_task'
        AND (? IS NULL OR m.value_json = ?)
    `).get(meta.sessionId, meta.routing.runtimeId, meta.routing.accountId, teamRunId, meta.teamId,
      LOCAL_USER_ID, meta.objective, meta.taskId, meta.assignedBotId, meta.revision ?? null,
      JSON.stringify(privateTaskSessionIdentity(meta)))
    return bound ? meta : null
  } catch {
    return null
  }
}

export function readPrivateTaskExecution(db: DatabaseHandle, meta: StoredTaskMeta) {
  return db.sqlite.prepare(`
    SELECT x.daemon_run_id, r.status
    FROM team_execution_links x
    JOIN team_tasks t ON t.id = x.team_task_id AND t.team_run_id = x.team_run_id AND t.attempt = x.attempt
    JOIN runs r ON r.id = x.daemon_run_id AND r.session_id = x.session_id AND r.agent_id = x.agent_id
    WHERE x.role = 'worker' AND x.team_task_id = ? AND x.team_run_id = ?
      AND x.agent_id = ? AND x.session_id = ? AND x.runtime_id = ? AND x.account_id = ?
      AND r.runtime_id = x.runtime_id AND r.model_id = ? AND r.effort = ?
      AND json_extract(r.config_snapshot_json, '$.teamRouting.teamId') = ?
      AND json_extract(r.config_snapshot_json, '$.teamRouting.teamRunId') = x.team_run_id
      AND json_extract(r.config_snapshot_json, '$.teamRouting.botId') = x.agent_id
      AND json_extract(r.config_snapshot_json, '$.teamRouting.accountId') = x.account_id
      AND (? IS NULL OR json_extract(r.config_snapshot_json, '$.teamRouting.revision') = ?)
    LIMIT 1
  `).get(meta.taskId, meta.teamRunId, meta.assignedBotId, meta.sessionId, meta.routing.runtimeId,
    meta.routing.accountId, meta.routing.modelId, meta.routing.effort, meta.teamId,
    meta.revision ?? null, meta.revision ?? null) as { daemon_run_id: string; status: string } | undefined
}
