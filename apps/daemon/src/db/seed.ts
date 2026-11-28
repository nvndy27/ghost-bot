import type { DatabaseHandle } from './client.ts'

const SEED_SETTING_KEY = 'seed.initial_bots.v1'

interface SeedBotDef {
  id: string
  name: string
  description: string
  instructions: string
  avatar: Record<string, unknown>
  runtimeId: string
  modelId: string
  effort: string
  workspacePath: string
  permissionMode: string
}

const INITIAL_BOTS: readonly SeedBotDef[] = [
  {
    id: 'chief',
    name: 'Chief of Staff',
    description: 'Workspace coordinator',
    instructions: 'Coordinate tasks across your workspace bots and summarize next actions.',
    avatar: {
      kind: 'preset',
      shape: 'chief',
      color: '#A3835D',
      eyes: 'classic',
      rotation: 0,
      animation: true,
    },
    runtimeId: 'mock-offline',
    modelId: 'mock-model',
    effort: 'medium',
    workspacePath: '~/Projects/ghost-bot',
    permissionMode: 'ask-approval',
  },
  {
    id: 'developer',
    name: 'Developer',
    description: 'Code & test assistant',
    instructions: 'Inspect code, run tests, and prepare minimal diffs.',
    avatar: {
      kind: 'preset',
      shape: 'developer',
      color: '#7765CF',
      eyes: 'classic',
      rotation: 0,
      animation: true,
    },
    runtimeId: 'mock-offline',
    modelId: 'mock-model',
    effort: 'medium',
    workspacePath: '~/Projects/ghost-bot',
    permissionMode: 'ask-approval',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Docs & technical research',
    instructions: 'Gather documentation and summarize technical findings.',
    avatar: {
      kind: 'preset',
      shape: 'researcher',
      color: '#418D79',
      eyes: 'round',
      rotation: 0,
      animation: true,
    },
    runtimeId: 'mock-offline',
    modelId: 'mock-model',
    effort: 'medium',
    workspacePath: '~/Projects/ghost-bot',
    permissionMode: 'read-only',
  },
  {
    id: 'email-assistant',
    name: 'Email Assistant',
    description: 'Inbox summary drafter',
    instructions: 'Draft inbox summaries for explicit user review.',
    avatar: {
      kind: 'preset',
      shape: 'automation',
      color: '#E89042',
      eyes: 'sleepy',
      rotation: 0,
      animation: true,
    },
    runtimeId: 'mock-offline',
    modelId: 'mock-model',
    effort: 'low',
    workspacePath: '~/Documents',
    permissionMode: 'read-only',
  },
  {
    id: 'daily-assistant',
    name: 'Daily Assistant',
    description: 'Daily priorities & notes',
    instructions: 'Keep track of daily priorities and personal notes.',
    avatar: {
      kind: 'preset',
      shape: 'assistant',
      color: '#438ECE',
      eyes: 'happy',
      rotation: 0,
      animation: true,
    },
    runtimeId: 'mock-offline',
    modelId: 'mock-model',
    effort: 'low',
    workspacePath: '~/Notes',
    permissionMode: 'read-only',
  },
]

export function seedInitialBotsIfNeeded(
  handle: DatabaseHandle,
  runtimeMode: 'codex' | 'mock' = 'mock',
): boolean {
  const alreadySeeded = handle.sqlite
    .prepare('SELECT key FROM settings WHERE key = ?')
    .get(SEED_SETTING_KEY)
  if (alreadySeeded) return false

  const existingCount = handle.sqlite
    .prepare('SELECT COUNT(*) AS cnt FROM agents')
    .get() as { cnt: number }
  const now = new Date().toISOString()

  return handle.transaction(() => {
    // The sample bots are explicitly mock-configured. Production profiles must
    // start empty until the user selects a discovered provider/model.
    if (existingCount.cnt === 0 && runtimeMode === 'mock') {
      const insert = handle.sqlite.prepare(`
        INSERT INTO agents (
          id, name, description, instructions, avatar_json,
          runtime_id, model_profile_id, model_id, effort,
          workspace_path, permission_mode, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?)
      `)
      for (const b of INITIAL_BOTS) {
        insert.run(
          b.id,
          b.name,
          b.description,
          b.instructions,
          JSON.stringify(b.avatar),
          b.runtimeId,
          b.modelId,
          b.effort,
          b.workspacePath,
          b.permissionMode,
          now,
          now,
        )
      }
      handle.sqlite
        .prepare('INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run('ui.activeBotId', JSON.stringify('chief'), now)
    }

    handle.sqlite
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(SEED_SETTING_KEY, JSON.stringify({ seededAt: now }), now)
    return true
  })
}
