import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildKnowledgeContext,
  KnowledgeAuthorizationError,
  KnowledgeIngestionPipeline,
  openKnowledgeDatabase,
  SqliteKnowledgeRepository,
  type KnowledgeAuthContext,
} from '../../src/index.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

const AUTH: KnowledgeAuthContext = {
  actorId: 'user-1',
  userId: 'user-1',
  botId: 'bot-1',
  workspaceId: 'ws-1',
  allowUserWideRead: true,
  allowUserWideWrite: true,
}

test('context builder enforces budgets, citations, deterministic ordering, and untrusted envelope on injection fixture', async () => {
  const handle = await openKnowledgeDatabase(':memory:')
  const repo = new SqliteKnowledgeRepository(handle, {
    clock: () => new Date('2026-11-25T14:00:00.000Z'),
  })
  const pipeline = new KnowledgeIngestionPipeline(repo)

  try {
    const injBytes = readFileSync(join(FIXTURES_DIR, 'prompt-injection.md'))
    const vnBytes = readFileSync(join(FIXTURES_DIR, 'sample-vn.md'))

    const injRes = pipeline.ingestBytes(AUTH, injBytes, {
      scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
      title: 'Injection Fixture',
      sourceType: 'markdown',
      mediaType: 'text/markdown',
      displayFilename: 'prompt-injection.md',
    })
    const vnRes = pipeline.ingestBytes(AUTH, vnBytes, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      title: 'VN Guide',
      sourceType: 'markdown',
      mediaType: 'text/markdown',
      displayFilename: 'sample-vn.md',
    })

    const candidates = [
      ...injRes.chunks.map((chunk) => ({ document: injRes.document, chunk, score: 50 })),
      ...vnRes.chunks.map((chunk) => ({ document: vnRes.document, chunk, score: 80 })),
    ]

    const ctx1 = buildKnowledgeContext(
      AUTH,
      candidates,
      { maxDocuments: 2, maxChunks: 4, maxChars: 8192, maxBytes: 8192 },
      () => new Date('2026-11-25T14:01:00.000Z'),
    )
    const ctx2 = buildKnowledgeContext(
      AUTH,
      candidates,
      { maxDocuments: 2, maxChunks: 4, maxChars: 8192, maxBytes: 8192 },
      () => new Date('2026-11-25T14:01:00.000Z'),
    )
    assert.deepEqual(ctx1, ctx2)
    assert.equal(ctx1.citations.length, ctx1.items.length)
    assert.ok(ctx1.metadata.bytes <= 8192)
    assert.ok(ctx1.metadata.chars <= 8192)
    assert.equal(ctx1.metadata.tokenEstimateMethod, 'chars_div_4_heuristic')

    const parsed = JSON.parse(ctx1.serialized)
    assert.equal(parsed.kind, 'untrusted_knowledge_reference_data')
    assert.equal(parsed.authority, 'none')

    // Tight byte budget for multi-byte Vietnamese & zero budget
    const tightBytes = buildKnowledgeContext(
      AUTH,
      candidates,
      { maxDocuments: 2, maxChunks: 4, maxChars: 10_000, maxBytes: 300 },
      () => new Date('2026-11-25T14:01:00.000Z'),
    )
    assert.equal(tightBytes.items.length, 0)
    assert.ok(tightBytes.metadata.bytes <= 300)

    const zero = buildKnowledgeContext(
      AUTH,
      candidates,
      { maxDocuments: 0, maxChunks: 0, maxChars: 0, maxBytes: 0, maxEstimatedTokens: 0 },
      () => new Date('2026-11-25T14:01:00.000Z'),
    )
    assert.equal(zero.serialized, '')

    // Cross-user candidate rejected
    const otherUserAuth: KnowledgeAuthContext = {
      actorId: 'user-2',
      userId: 'user-2',
      botId: 'bot-1',
      allowUserWideRead: false,
    }
    assert.throws(
      () => buildKnowledgeContext(otherUserAuth, candidates, {}),
      KnowledgeAuthorizationError,
    )
  } finally {
    repo.close()
  }
})
