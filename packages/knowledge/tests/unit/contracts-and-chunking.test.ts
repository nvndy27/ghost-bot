import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chunkDocumentText,
  extractUtf8DocumentText,
  IngestBytesInputSchema,
  KNOWLEDGE_LIMITS,
  KnowledgeUnsupportedFormatError,
  KnowledgeValidationError,
} from '../../src/index.ts'

test('contracts reject unexpected fields and extractors reject unsupported/invalid formats', () => {
  const extra = IngestBytesInputSchema.safeParse({
    scope: { kind: 'bot', userId: 'user-1', botId: 'bot-1' },
    title: 'Valid title',
    sourceType: 'direct_text',
    mediaType: 'text/plain',
    unexpected: true,
  })
  assert.equal(extra.success, false)

  // PDF and DOCX explicitly rejected as unsupported
  assert.throws(
    () => extractUtf8DocumentText(Buffer.from('%PDF-1.7'), 'text_file', 'application/pdf', 'doc.pdf'),
    KnowledgeUnsupportedFormatError,
  )
  assert.throws(
    () =>
      extractUtf8DocumentText(
        Buffer.from('PK\x03\x04'),
        'text_file',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'doc.docx',
      ),
    KnowledgeUnsupportedFormatError,
  )

  // Empty, NUL-byte, and invalid UTF-8 rejected
  assert.throws(() => extractUtf8DocumentText(Buffer.alloc(0), 'direct_text', 'text/plain'), KnowledgeValidationError)
  assert.throws(() => extractUtf8DocumentText(Buffer.from('abc\0def'), 'text_file', 'text/plain'), KnowledgeValidationError)
  assert.throws(
    () => extractUtf8DocumentText(Buffer.from([0xff, 0xfe, 0xfd]), 'text_file', 'text/plain'),
    KnowledgeValidationError,
  )
})

test('chunker preserves Markdown headings, line ranges, Unicode surrogate pairs, and enforces limits', () => {
  const md = [
    '# Section One',
    '',
    'First paragraph with Tiếng Việt and emoji 🚀🔥.',
    '',
    '## Subsection A',
    '',
    'Second paragraph in subsection A.',
  ]
    .join('\n')
    .normalize('NFD')

  const extracted = extractUtf8DocumentText(Buffer.from(md, 'utf8'), 'markdown', 'text/markdown', 'guide.md')
  const chunks = chunkDocumentText(extracted.normalizedText, 'markdown', {
    targetChunkChars: 120,
    maxChunkChars: 200,
    overlapChars: 20,
  })

  assert.ok(chunks.length >= 2)
  assert.deepEqual(chunks[0]!.location.sectionPath, ['Section One'])
  assert.equal(chunks[0]!.location.pageNumber, null)
  assert.ok(chunks[0]!.location.startLine >= 1)
  assert.ok(chunks[0]!.location.endLine >= chunks[0]!.location.startLine)

  const subChunk = chunks.find((c) => c.content.includes('Second paragraph'))
  assert.ok(subChunk)
  assert.deepEqual(subChunk.location.sectionPath, ['Section One', 'Subsection A'])

  // Large paragraph with emoji splits safely without broken UTF-16 surrogates
  const emojiPara = '🚀'.repeat(150)
  const emojiChunks = chunkDocumentText(emojiPara, 'direct_text', {
    targetChunkChars: 80,
    maxChunkChars: 100,
    overlapChars: 10,
  })
  assert.ok(emojiChunks.length >= 2)
  for (const c of emojiChunks) {
    assert.equal(Buffer.from(c.content, 'utf8').toString('utf8'), c.content)
    assert.ok(c.content.length <= 100)
  }

  // Invalid overlap rejected (prevents infinite loop)
  assert.throws(
    () =>
      chunkDocumentText('Some sample text that is long enough.', 'direct_text', {
        targetChunkChars: 64,
        maxChunkChars: 100,
        overlapChars: 64,
      }),
    KnowledgeValidationError,
  )

  // Exceeding maxChunksPerDocument fails cleanly
  const manyParas = Array.from(
    { length: KNOWLEDGE_LIMITS.maxChunksPerDocument + 5 },
    (_, i) => `Paragraph ${i} with enough deterministic text content to occupy a chunk.`,
  ).join('\n\n')
  assert.throws(
    () =>
      chunkDocumentText(manyParas, 'direct_text', {
        targetChunkChars: 64,
        maxChunkChars: 64,
        overlapChars: 0,
      }),
    KnowledgeValidationError,
  )
})
