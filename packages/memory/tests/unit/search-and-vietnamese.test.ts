import assert from 'node:assert/strict'
import test from 'node:test'
import {
  openMemoryDatabase,
  SqliteMemoryRepository,
  type MemoryAuthContext,
} from '../../src/index.ts'

const AUTH: MemoryAuthContext = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

for (const enableFts5 of [true, false]) {
  const modeLabel = enableFts5 ? 'fts5' : 'lexical_fallback'

  test(`search supports Vietnamese Unicode, ranking, tie-breaking, and injection safety (${modeLabel})`, async () => {
    const handle = await openMemoryDatabase(':memory:', { enableFts5 })
    let tick = 0
    const repo = new SqliteMemoryRepository(handle, {
      clock: () => new Date(Date.UTC(2026, 10, 25, 10, 0, tick++)),
    })

    try {
      // NFD vs NFC Vietnamese text and đ/Đ handling
      const nfdContent = 'Cài đặt môi trường phát triển bằng tiếng Việt'.normalize('NFD')
      const m1 = repo.create(AUTH, {
        id: 'mem-b',
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        category: 'project_context',
        content: nfdContent,
        tags: ['việt-nam', 'setup'],
      })
      const m2 = repo.create(AUTH, {
        id: 'mem-a',
        scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
        category: 'project_context',
        content: 'Hướng dẫn cài đặt dự án Ghost Bot trên Fedora',
        tags: ['fedora', 'setup'],
      })
      // Duplicate content in user scope to test cross-scope deduplication
      repo.create(AUTH, {
        id: 'mem-c',
        scope: { kind: 'user', userId: 'user-1' },
        category: 'project_context',
        content: 'Hướng dẫn cài đặt dự án Ghost Bot trên Fedora',
        tags: ['fedora'],
      })

      // Exact Vietnamese accent search
      const exactRes = repo.search(AUTH, {
        query: 'cài đặt',
        includeUserWide: true,
        deduplicateAcrossScopes: true,
      })
      assert.equal(exactRes.engine, modeLabel)
      assert.equal(exactRes.items.length, 2)
      // Workspace scope outranks bot scope for identical match strength
      assert.equal(exactRes.items[0]!.record.id, m2.id)
      assert.equal(exactRes.items[1]!.record.id, m1.id)

      // Accent-folded search (including đ -> d)
      const foldedRes = repo.search(AUTH, {
        query: 'cai dat tieng Viet',
        includeUserWide: false,
      })
      assert.ok(foldedRes.items.some((item) => item.record.id === m1.id))

      // Tag filtering
      const taggedRes = repo.search(AUTH, {
        query: 'cài đặt',
        tags: ['fedora'],
        includeUserWide: true,
      })
      assert.equal(taggedRes.items.length, 1)
      assert.equal(taggedRes.items[0]!.record.id, m2.id)

      // Malformed / FTS5-injection / SQL-injection queries must never throw or leak
      const adversarialQueries = [
        '??? *** ::: ^^^ () []',
        '" OR 1=1 --; DROP TABLE memories; --',
        'content:secret NEAR(a, b) NOT *',
        'AND OR NOT',
      ]
      for (const q of adversarialQueries) {
        const res = repo.search(AUTH, { query: q, includeUserWide: true })
        assert.ok(Array.isArray(res.items))
      }
    } finally {
      repo.close()
    }
  })
}
