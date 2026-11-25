import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KnowledgeAuthorizationError,
  KnowledgeCredentialError,
  KnowledgeDuplicateError,
  KnowledgeIngestionPipeline,
  KnowledgeStorageCorruptionError,
  KnowledgeStorageError,
  openKnowledgeDatabase,
  SqliteKnowledgeRepository,
  type KnowledgeAuthContext,
} from '../../src/index.ts'

const AUTH: KnowledgeAuthContext = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

test('SQLite persistence: collections, ingestion, reopen, atomic replacement, rollback, archive, delete, and close', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-know-int-'))
  const dbPath = join(rootDir, 'store', 'knowledge.sqlite')

  try {
    let tick = 0
    const clock = () => new Date(Date.UTC(2026, 10, 25, 15, 0, tick++))

    const h1 = await openKnowledgeDatabase(dbPath)
    const repo1 = new SqliteKnowledgeRepository(h1, { clock })
    const pipeline1 = new KnowledgeIngestionPipeline(repo1)

    const col = repo1.createCollection(AUTH, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      name: 'Architecture Docs',
      description: 'Core design notes',
    })
    assert.equal(repo1.listCollections(AUTH).length, 1)

    // Cannot link workspace document to bot-scoped collection
    const botCol = repo1.createCollection(AUTH, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      name: 'Bot Notes',
    })
    assert.throws(
      () =>
        pipeline1.ingestText(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          collectionId: botCol.id,
          title: 'Mismatched Collection',
          text: 'Should fail collection scope check.',
        }),
      KnowledgeAuthorizationError,
    )

    const doc1 = pipeline1.ingestText(AUTH, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      collectionId: col.id,
      title: 'Ghost Bot Guide',
      sourceType: 'markdown',
      text: '# Intro\n\nUse node:sqlite with WAL mode.',
      tags: ['sqlite', 'guide'],
    })

    // Duplicate in same scope rejected
    assert.throws(
      () =>
        pipeline1.ingestText(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          title: 'Duplicate Guide',
          sourceType: 'markdown',
          text: '# Intro\n\nUse node:sqlite with WAL mode.',
        }),
      KnowledgeDuplicateError,
    )

    // Same content in different scope succeeds
    const docOtherScope = pipeline1.ingestText(AUTH, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      title: 'Bot Copy',
      sourceType: 'markdown',
      text: '# Intro\n\nUse node:sqlite with WAL mode.',
    })
    assert.notEqual(docOtherScope.document.id, doc1.document.id)

    repo1.close()

    // Reopen and verify persistence, replacement, failed-replacement rollback, archive, delete
    const h2 = await openKnowledgeDatabase(dbPath)
    const repo2 = new SqliteKnowledgeRepository(h2, { clock })
    const pipeline2 = new KnowledgeIngestionPipeline(repo2)

    const loaded = repo2.getDocumentById(AUTH, doc1.document.id)
    assert.ok(loaded)
    assert.equal(repo2.getDocumentChunks(AUTH, doc1.document.id).length, doc1.chunks.length)

    // Valid replacement creates revision 2 and invalidates revision 1 citations
    const oldChunkId = doc1.chunks[0]!.id
    const oldRevId = doc1.revision.id
    const replaced = pipeline2.replaceWithBytes(
      AUTH,
      doc1.document.id,
      Buffer.from('# Updated\n\nReplaced with strict TypeScript guidance.', 'utf8'),
      {
        collectionId: col.id,
        scope: doc1.document.scope,
        title: 'Ghost Bot Guide v2',
        sourceType: 'markdown',
        mediaType: 'text/markdown',
        tags: ['sqlite', 'v2'],
      },
    )
    assert.equal(replaced.revision.revisionNumber, 2)
    assert.equal(
      repo2.resolveCitation(AUTH, {
        documentId: doc1.document.id,
        revisionId: oldRevId,
        chunkId: oldChunkId,
      }),
      null,
    )
    assert.ok(
      repo2.resolveCitation(AUTH, {
        documentId: doc1.document.id,
        revisionId: replaced.revision.id,
        chunkId: replaced.chunks[0]!.id,
      }),
    )

    // Failed replacement (credential in text) preserves revision 2 intact
    assert.throws(
      () =>
        pipeline2.replaceWithBytes(
          AUTH,
          doc1.document.id,
          Buffer.from('Bad replacement sk-proj-1234567890abcdef1234', 'utf8'),
          {
            collectionId: col.id,
            scope: doc1.document.scope,
            title: 'Bad',
            sourceType: 'direct_text',
            mediaType: 'text/plain',
          },
        ),
      KnowledgeCredentialError,
    )
    assert.equal(repo2.search(AUTH, { query: 'TypeScript guidance' }).items.length, 1)

    // Archive excludes from search and citation resolution
    repo2.archiveDocument(AUTH, doc1.document.id)
    assert.equal(repo2.search(AUTH, { query: 'TypeScript guidance' }).items.length, 0)
    assert.equal(
      repo2.resolveCitation(AUTH, {
        documentId: doc1.document.id,
        revisionId: replaced.revision.id,
        chunkId: replaced.chunks[0]!.id,
      }),
      null,
    )

    // Delete removes document and FTS entries
    assert.equal(repo2.deleteDocument(AUTH, docOtherScope.document.id), true)
    assert.equal(repo2.getDocumentById(AUTH, docOtherScope.document.id), null)

    // Corrupt row fails closed with KnowledgeStorageCorruptionError
    h2.sqlite.prepare("UPDATE knowledge_documents SET tags_json = '{bad' WHERE id = ?").run(doc1.document.id)
    assert.throws(
      () => repo2.getDocumentById(AUTH, doc1.document.id, { includeArchived: true }),
      KnowledgeStorageCorruptionError,
    )

    // Closed repository fails closed
    repo2.close()
    repo2.close()
    assert.throws(() => repo2.listDocuments(AUTH), KnowledgeStorageError)

    // Corrupt DB file fails safely on open
    const corruptDb = join(rootDir, 'store', 'corrupt.sqlite')
    writeFileSync(corruptDb, 'corrupt-sqlite-bytes', { mode: 0o600 })
    await assert.rejects(() => openKnowledgeDatabase(corruptDb))
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})
