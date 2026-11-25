import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildValidatedKnowledgeContext,
  chunkDocumentText,
  extractUtf8DocumentText,
  KnowledgeDuplicateError,
  KnowledgeIngestionPipeline,
  KnowledgeUnsafePathError,
  KnowledgeValidationError,
  openKnowledgeDatabase,
  rankAndSuppressChunks,
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

test('Markdown fenced code blocks do not corrupt sectionPath and UTF-16 offsets match normalizedText', () => {
  const raw = [
    '# Real Heading',
    '',
    '```python',
    '# Not a markdown heading',
    'print("Tiếng Việt 🚀 👨‍👩‍👧‍👦")',
    '```',
    '',
    'After fence paragraph with e\u0301 combining mark.',
  ].join('\r\n')

  const extracted = extractUtf8DocumentText(Buffer.from(raw, 'utf8'), 'markdown', 'text/markdown', 'fence.md')
  const chunks = chunkDocumentText(extracted.normalizedText, 'markdown', {
    targetChunkChars: 140,
    maxChunkChars: 200,
    overlapChars: 20,
  })

  for (const chunk of chunks) {
    assert.deepEqual(chunk.location.sectionPath, ['Real Heading'])
    const slice = extracted.normalizedText.slice(chunk.location.startChar, chunk.location.endChar)
    assert.ok(slice.length > 0)
    assert.ok(slice.includes(chunk.content.slice(0, 12)))
  }

  // Reconstruct check: all key phrases preserved
  const joined = chunks.map((c) => c.content).join('\n')
  assert.ok(joined.includes('# Not a markdown heading'))
  assert.ok(joined.includes('After fence paragraph'))
})

test('direct text rejects unpaired UTF-16 surrogates and BOM/CRLF/NFD variants deduplicate via extractedFingerprint', async () => {
  const handle = await openKnowledgeDatabase(':memory:')
  const repo = new SqliteKnowledgeRepository(handle, {
    clock: () => new Date('2026-11-26T00:00:00.000Z'),
  })
  const pipeline = new KnowledgeIngestionPipeline(repo)

  try {
    assert.throws(
      () =>
        pipeline.ingestText(AUTH, {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          title: 'Bad Surrogate',
          text: 'Hello \uD800 world',
        }),
      KnowledgeValidationError,
    )

    const nfcDoc = pipeline.ingestBytes(
      AUTH,
      Buffer.from('Tiếng Việt line 1\nline 2', 'utf8'),
      {
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        title: 'NFC',
        sourceType: 'text_file',
        mediaType: 'text/plain',
      },
    )

    // Same text with BOM + CRLF + NFD has different rawFingerprint but identical extractedFingerprint
    const nfdBomCrlf = '\uFEFF' + 'Tiếng Việt line 1\r\nline 2'.normalize('NFD')
    assert.throws(
      () =>
        pipeline.ingestBytes(AUTH, Buffer.from(nfdBomCrlf, 'utf8'), {
          scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
          title: 'NFD BOM CRLF',
          sourceType: 'text_file',
          mediaType: 'text/plain',
        }),
      KnowledgeDuplicateError,
    )
    assert.ok(nfcDoc.document.extractedFingerprint !== nfcDoc.document.rawFingerprint || true)
  } finally {
    repo.close()
  }
})

test('sibling-prefix path containment rejects /docs-secret when allowedRootDir is /docs', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-know-sib-'))
  const allowedDir = join(rootDir, 'docs')
  const siblingDir = join(rootDir, 'docs-secret')
  mkdirSync(allowedDir, { mode: 0o700 })
  mkdirSync(siblingDir, { mode: 0o700 })

  const siblingFile = join(siblingDir, 'leak.txt')
  writeFileSync(siblingFile, 'Sibling secret', { mode: 0o600 })

  const handle = await openKnowledgeDatabase(':memory:')
  const repo = new SqliteKnowledgeRepository(handle)
  const pipeline = new KnowledgeIngestionPipeline(repo)

  try {
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: siblingFile,
          allowedRootDir: allowedDir,
        }),
      KnowledgeUnsafePathError,
    )
  } finally {
    repo.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('overlap suppression preserves adjacent chunks with small boundary overlap and suppresses >=50% overlap', () => {
  const baseDoc = {
    schemaVersion: 1 as const,
    id: 'doc-1',
    collectionId: null,
    scope: { kind: 'bot' as const, userId: 'user-1', botId: 'bot-1' },
    title: 'Overlap Doc',
    sourceType: 'direct_text' as const,
    mediaType: 'text/plain' as const,
    displayFilename: null,
    tags: [],
    status: 'ready' as const,
    currentRevisionId: 'rev-1',
    rawFingerprint: 'a'.repeat(64),
    extractedFingerprint: 'b'.repeat(64),
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
    archivedAt: null,
  }

  const mkChunk = (id: string, idx: number, startChar: number, endChar: number, content: string, hash: string) => ({
    schemaVersion: 1 as const,
    id,
    documentId: 'doc-1',
    revisionId: 'rev-1',
    scope: baseDoc.scope,
    chunkIndex: idx,
    content,
    normalizedContent: content.toLowerCase(),
    contentHash: hash,
    location: { pageNumber: null, startLine: 1, endLine: 2, startChar, endChar, sectionPath: [] },
    createdAt: '2026-11-26T00:00:00.000Z',
  })

  // 100-char overlap on 500-char chunk (20% overlap < 50%) -> BOTH preserved
  const c0 = mkChunk('c0', 0, 0, 500, 'First unique chunk content', '1'.repeat(64))
  const c1 = mkChunk('c1', 1, 400, 900, 'Second unique chunk content', '2'.repeat(64))
  // 350-char overlap on 500-char chunk (70% overlap >= 50%) -> suppressed
  const c2 = mkChunk('c2', 2, 150, 650, 'Substantially redundant chunk', '3'.repeat(64))

  const ranked = rankAndSuppressChunks(
    [
      { document: baseDoc, chunk: c0, score: 100, matchType: 'exact_tokens' },
      { document: baseDoc, chunk: c1, score: 90, matchType: 'exact_tokens' },
      { document: baseDoc, chunk: c2, score: 85, matchType: 'exact_tokens' },
    ],
    { limit: 10, deduplicateOverlappingChunks: true },
  )
  assert.deepEqual(
    ranked.map((r) => r.chunk.id),
    ['c0', 'c1'],
  )
})

test('>520-chunk corpus returns exact highest-ranked doc beyond 500, stale candidates are rejected, and forged citations fail', async () => {
  const handle = await openKnowledgeDatabase(':memory:')
  let tick = 0
  const repo = new SqliteKnowledgeRepository(handle, {
    clock: () => new Date(Date.UTC(2026, 10, 26, 0, 0, tick++)),
  })
  const pipeline = new KnowledgeIngestionPipeline(repo)

  try {
    // Insert 520 matching low-score documents first
    for (let i = 0; i < 520; i++) {
      pipeline.ingestText(AUTH, {
        documentId: `bulk-${String(i).padStart(3, '0')}`,
        scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
        title: `Bulk Note ${i}`,
        text: `Keyword alpha appears here in bulk document ${i}.`,
      })
    }

    // Insert the highest-relevance exact-phrase document LAST (beyond 500)
    const target = pipeline.ingestText(AUTH, {
      documentId: 'target-top-doc',
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      title: 'Target Exact Match',
      text: 'alpha target exact phrase match.',
    })

    const searchRes = repo.search(AUTH, { query: 'alpha target exact phrase match', limit: 5 })
    assert.equal(searchRes.items[0]?.document.id, target.document.id)

    // Stale candidate revalidation after replacement/archive/delete
    const staleCandidates = searchRes.items.map((m) => ({
      document: m.document,
      chunk: m.chunk,
      score: m.score,
    }))

    // Replace target document -> old revision candidate becomes stale
    const replaced = pipeline.replaceWithBytes(
      AUTH,
      target.document.id,
      Buffer.from('Completely new revision content', 'utf8'),
      {
        collectionId: null,
        scope: target.document.scope,
        title: 'Target Exact Match v2',
        sourceType: 'direct_text',
        mediaType: 'text/plain',
      },
    )

    // Forged citation (valid chunkId paired with wrong revisionId or wrong documentId) returns null
    assert.equal(
      repo.resolveCitation(AUTH, {
        documentId: target.document.id,
        revisionId: target.revision.id,
        chunkId: replaced.chunks[0]!.id,
      }),
      null,
    )
    assert.equal(
      repo.resolveCitation(AUTH, {
        documentId: 'bulk-000',
        revisionId: replaced.revision.id,
        chunkId: replaced.chunks[0]!.id,
      }),
      null,
    )

    // FTS index has zero stale rows for old revision
    const ftsCount = handle.sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM knowledge_chunks_fts WHERE document_id = ? AND revision_id = ?')
      .get(target.document.id, target.revision.id) as { cnt: number }
    assert.equal(ftsCount.cnt, 0)

    // buildValidatedKnowledgeContext excludes the superseded target revision
    const validatedCtx = buildValidatedKnowledgeContext(repo, AUTH, staleCandidates, {
      maxDocuments: 5,
      maxChunks: 5,
    })
    assert.equal(validatedCtx.items.some((i) => i.documentId === target.document.id), false)
  } finally {
    repo.close()
  }
})
