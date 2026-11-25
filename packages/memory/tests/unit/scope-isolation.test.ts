import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryMemoryRepository,
  MemoryAuthorizationError,
  MemoryDuplicateError,
  MemoryNotFoundError,
  type MemoryAuthContext,
} from '../../src/index.ts'

test('enforces cross-user, cross-bot, and cross-workspace isolation across all operations', () => {
  let now = new Date('2026-11-25T10:00:00.000Z')
  const repo = new InMemoryMemoryRepository({ clock: () => now })

  const user1Bot1: MemoryAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: false,
    allowUserWideWrite: false,
  }
  const user1Bot2: MemoryAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-2',
    workspaceId: 'ws-2',
    allowUserWideRead: false,
    allowUserWideWrite: false,
  }
  const user2Bot1: MemoryAuthContext = {
    actorId: 'user-2',
    userId: 'user-2',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  }

  const bot1Mem = repo.create(user1Bot1, {
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    category: 'preference',
    content: 'Secret bot-1 preference alpha',
  })
  const ws1Mem = repo.create(user1Bot1, {
    scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
    category: 'project_context',
    content: 'Workspace-1 build uses pnpm',
  })

  // Cross-user denial (even with same botId/workspaceId names)
  assert.equal(repo.getById(user2Bot1, bot1Mem.id), null)
  assert.equal(repo.getById(user2Bot1, ws1Mem.id), null)
  assert.equal(repo.list(user2Bot1).total, 0)
  assert.equal(repo.search(user2Bot1, { query: 'alpha' }).items.length, 0)
  assert.throws(() => repo.update(user2Bot1, bot1Mem.id, { content: 'hijack' }), MemoryNotFoundError)
  assert.throws(() => repo.archive(user2Bot1, bot1Mem.id), MemoryNotFoundError)
  assert.throws(() => repo.delete(user2Bot1, bot1Mem.id), MemoryNotFoundError)
  assert.throws(
    () =>
      repo.create(user2Bot1, {
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        category: 'fact',
        content: 'Spoofed userId',
      }),
    MemoryAuthorizationError,
  )

  // Cross-bot & cross-workspace denial for same user
  assert.equal(repo.getById(user1Bot2, bot1Mem.id), null)
  assert.equal(repo.getById(user1Bot2, ws1Mem.id), null)
  assert.equal(repo.list(user1Bot2).total, 0)
  assert.equal(repo.search(user1Bot2, { query: 'pnpm' }).items.length, 0)
  assert.throws(() => repo.update(user1Bot2, bot1Mem.id, { content: 'hijack' }), MemoryNotFoundError)
  assert.throws(() => repo.delete(user1Bot2, ws1Mem.id), MemoryNotFoundError)

  // Duplicate detection does NOT leak or suppress across scopes
  const sameContentInBot2 = repo.create(user1Bot2, {
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-2' },
    category: 'preference',
    content: 'Secret bot-1 preference alpha',
  })
  assert.notEqual(sameContentInBot2.id, bot1Mem.id)
  assert.equal(
    repo.findDuplicate(user1Bot2, { kind: 'bot', userId: 'user-1', botId: 'bot-1' }, 'Secret bot-1 preference alpha'),
    null,
  )

  // Duplicate within same active scope fails
  assert.throws(
    () =>
      repo.create(user1Bot1, {
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        category: 'preference',
        content: '  secret   bot-1 PREFERENCE alpha ',
      }),
    MemoryDuplicateError,
  )

  // Archived and expired exclusion
  now = new Date('2026-11-25T10:05:00.000Z')
  const expiring = repo.create(user1Bot1, {
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    category: 'fact',
    content: 'Temporary token-free note',
    expiresAt: '2026-11-25T10:10:00.000Z',
  })
  assert.ok(repo.getById(user1Bot1, expiring.id))

  now = new Date('2026-11-25T10:10:00.000Z')
  assert.equal(repo.getById(user1Bot1, expiring.id), null)
  assert.equal(repo.search(user1Bot1, { query: 'Temporary' }).items.length, 0)

  repo.archive(user1Bot1, bot1Mem.id)
  assert.equal(repo.getById(user1Bot1, bot1Mem.id), null)
  assert.equal(repo.search(user1Bot1, { query: 'alpha' }).items.length, 0)
})

test('user-wide memory requires explicit authorization and explicit inclusion', () => {
  const repo = new InMemoryMemoryRepository({ clock: () => new Date('2026-11-25T10:00:00.000Z') })
  const writerAuth: MemoryAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  }
  const restrictedReadAuth: MemoryAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    allowUserWideRead: false,
    allowUserWideWrite: false,
  }

  const userWide = repo.create(writerAuth, {
    scope: { kind: 'user', userId: 'user-1' },
    category: 'preference',
    content: 'User prefers Vietnamese explanations',
  })

  // Implicit fallback to user-wide is forbidden
  assert.equal(repo.getById(writerAuth, userWide.id), null)
  assert.equal(repo.list(writerAuth, { includeUserWide: false }).total, 0)
  assert.equal(repo.search(writerAuth, { query: 'Vietnamese', includeUserWide: false }).items.length, 0)

  // Explicit opt-in with authorized context succeeds
  assert.ok(repo.getById(writerAuth, userWide.id, { includeUserWide: true }))
  assert.equal(repo.list(writerAuth, { includeUserWide: true }).total, 1)
  assert.equal(repo.search(writerAuth, { query: 'Vietnamese', includeUserWide: true }).items.length, 1)

  // Unauthorized context cannot read user-wide even if includeUserWide=true
  assert.equal(repo.getById(restrictedReadAuth, userWide.id, { includeUserWide: true }), null)
  assert.equal(repo.list(restrictedReadAuth, { includeUserWide: true }).total, 0)
  assert.throws(
    () => repo.list(restrictedReadAuth, { scopeKinds: ['user'], includeUserWide: true }),
    MemoryAuthorizationError,
  )
})
