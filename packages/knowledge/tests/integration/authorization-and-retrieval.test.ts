import assert from 'node:assert/strict'
import test from 'node:test'
import {
  KnowledgeAuthorizationError,
  KnowledgeIngestionPipeline,
  KnowledgeNotFoundError,
  openKnowledgeDatabase,
  SqliteKnowledgeRepository,
  type KnowledgeAuthContext,
} from '../../src/index.ts'

test('authorization isolation across users, bots, workspaces, and user-wide read/write separation', async () => {
  const handle = await openKnowledgeDatabase(':memory:')
  const repo = new SqliteKnowledgeRepository(handle, {
    clock: () => new Date('2026-11-25T16:00:00.000Z'),
  })
  const pipeline = new KnowledgeIngestionPipeline(repo)

  const user1Bot1: KnowledgeAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: false,
  }
  const user1Bot2: KnowledgeAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-2',
    workspaceId: 'ws-2',
    allowUserWideRead: false,
    allowUserWideWrite: false,
  }
  const user2: KnowledgeAuthContext = {
    actorId: 'user-2',
    userId: 'user-2',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  }

  try {
    const docBot1 = pipeline.ingestText(user1Bot1, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      title: 'Bot1 Confidential Spec',
      text: 'Alpha secret architecture specification',
    })

    // User-wide read does not grant user-wide write
    assert.throws(
      () =>
        pipeline.ingestText(user1Bot1, {
          scope: { kind: 'user', userId: 'user-1' },
          title: 'User Wide',
          text: 'Should fail write check',
        }),
      KnowledgeAuthorizationError,
    )

    // Cross-user and cross-bot denial across all operations
    for (const unauthorized of [user2, user1Bot2]) {
      assert.equal(repo.getDocumentById(unauthorized, docBot1.document.id), null)
      assert.equal(repo.getDocumentChunks(unauthorized, docBot1.document.id).length, 0)
      assert.equal(repo.listDocuments(unauthorized).total, 0)
      assert.equal(repo.search(unauthorized, { query: 'Alpha' }).items.length, 0)
      assert.equal(
        repo.resolveCitation(unauthorized, {
          documentId: docBot1.document.id,
          revisionId: docBot1.revision.id,
          chunkId: docBot1.chunks[0]!.id,
        }),
        null,
      )
      assert.equal(
        repo.findDuplicateByFingerprint(
          unauthorized,
          docBot1.document.scope,
          docBot1.document.extractedFingerprint,
        ),
        null,
      )
      assert.throws(
        () => repo.updateDocumentMetadata(unauthorized, docBot1.document.id, { title: 'Hijacked' }),
        KnowledgeNotFoundError,
      )
      assert.throws(() => repo.archiveDocument(unauthorized, docBot1.document.id), KnowledgeNotFoundError)
      assert.throws(() => repo.deleteDocument(unauthorized, docBot1.document.id), KnowledgeNotFoundError)
    }
  } finally {
    repo.close()
  }
})

test('retrieval parity across FTS5 and lexical fallback with Vietnamese Unicode and injection resistance', async () => {
  const auth: KnowledgeAuthContext = {
    actorId: 'user-1',
    userId: 'user-1',
    botId: 'bot-1',
    workspaceId: 'ws-1',
    allowUserWideRead: true,
    allowUserWideWrite: true,
  }

  const handles = [
    await openKnowledgeDatabase(':memory:', { enableFts5: true }),
    await openKnowledgeDatabase(':memory:', { enableFts5: false }),
  ]

  try {
    const outputs: Array<{ engine: string; docIds: string[] }> = []
    for (const h of handles) {
      let tick = 0
      const repo = new SqliteKnowledgeRepository(h, {
        clock: () => new Date(Date.UTC(2026, 10, 25, 16, 30, tick++)),
      })
      const pipeline = new KnowledgeIngestionPipeline(repo)

      const d1 = pipeline.ingestText(auth, {
        documentId: 'doc-da-nang',
        scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
        title: 'Triển khai tại Đà Nẵng',
        sourceType: 'markdown',
        text: '# Hạ tầng\n\nHệ thống chạy tại Đà Nẵng bằng Tiếng Việt.'.normalize('NFD'),
        tags: ['vietnam', 'deploy'],
      })
      const d2 = pipeline.ingestText(auth, {
        documentId: 'doc-dien-bien',
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        title: 'Lịch sử Điện Biên',
        sourceType: 'markdown',
        text: 'Nghiên cứu địa lí khu vực Điện Biên Phủ.',
        tags: ['history'],
      })

      const resDaNang = repo.search(auth, { query: 'Da Nang Tieng Viet' })
      assert.equal(resDaNang.items[0]?.document.id, d1.document.id)
      assert.equal(resDaNang.citations[0]?.documentId, d1.document.id)

      const resDienBien = repo.search(auth, { query: 'dia li Dien Bien' })
      assert.equal(resDienBien.items[0]?.document.id, d2.document.id)

      // Document filter
      const filtered = repo.search(auth, { query: 'Đà Nẵng', documentId: d2.document.id })
      assert.equal(filtered.items.length, 0)

      // Malformed / FTS injection queries must not fail or leak
      for (const bad of ['??? *** :::', '" OR 1=1 --; DROP TABLE knowledge_documents;', 'AND OR NOT']) {
        const safe = repo.search(auth, { query: bad })
        assert.ok(Array.isArray(safe.items))
      }

      outputs.push({
        engine: resDaNang.engine,
        docIds: resDaNang.items.map((i) => i.document.id),
      })
    }

    assert.equal(outputs[0]?.engine, 'fts5')
    assert.equal(outputs[1]?.engine, 'lexical_fallback')
    assert.deepEqual(outputs[0]?.docIds, outputs[1]?.docIds)
  } finally {
    for (const h of handles) h.close()
  }
})
