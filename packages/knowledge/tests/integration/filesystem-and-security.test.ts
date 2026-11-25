import assert from 'node:assert/strict'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KNOWLEDGE_LIMITS,
  KnowledgeCredentialError,
  KnowledgeIngestionPipeline,
  KnowledgeUnsafePathError,
  KnowledgeValidationError,
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

test('filesystem and parser security: authorized root, traversal/symlink/hardlink rejection, size bounds, and credentials', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ghost-bot-know-sec-'))
  const allowedDir = join(rootDir, 'docs-root')
  const outsideDir = join(rootDir, 'outside')
  mkdirSync(allowedDir, { mode: 0o700 })
  mkdirSync(outsideDir, { mode: 0o700 })

  const handle = await openKnowledgeDatabase(join(rootDir, 'db', 'knowledge.sqlite'))
  const repo = new SqliteKnowledgeRepository(handle, {
    clock: () => new Date('2026-11-25T17:00:00.000Z'),
  })
  const pipeline = new KnowledgeIngestionPipeline(repo)

  try {
    assert.equal(statSync(join(rootDir, 'db')).mode & 0o777, 0o700)
    assert.equal(statSync(join(rootDir, 'db', 'knowledge.sqlite')).mode & 0o777, 0o600)

    const validFile = join(allowedDir, 'notes.md')
    writeFileSync(validFile, '# Valid Doc\n\nSafe local content.', { mode: 0o600 })

    const ingested = await pipeline.ingestFile(AUTH, {
      scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
      filePath: validFile,
      allowedRootDir: allowedDir,
    })
    assert.equal(ingested.document.sourceType, 'markdown')
    assert.equal(ingested.document.displayFilename, 'notes.md')

    // Path traversal outside allowedRootDir rejected
    const outsideFile = join(outsideDir, 'secret.txt')
    writeFileSync(outsideFile, 'Outside file content', { mode: 0o600 })
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: '../outside/secret.txt',
          allowedRootDir: allowedDir,
        }),
      KnowledgeUnsafePathError,
    )

    // Symlink inside allowedRootDir pointing outside rejected
    const symlinkFile = join(allowedDir, 'link.txt')
    symlinkSync(outsideFile, symlinkFile)
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: symlinkFile,
          allowedRootDir: allowedDir,
        }),
      KnowledgeUnsafePathError,
    )

    // Hardlink inside allowedRootDir rejected
    const hardlinkFile = join(allowedDir, 'hardlink.txt')
    linkSync(validFile, hardlinkFile)
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: hardlinkFile,
          allowedRootDir: allowedDir,
        }),
      KnowledgeUnsafePathError,
    )

    // Directory instead of file rejected
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: allowedDir,
          allowedRootDir: rootDir,
        }),
      KnowledgeUnsafePathError,
    )

    // Oversized file rejected before full ingestion
    const oversizedFile = join(allowedDir, 'big.txt')
    writeFileSync(oversizedFile, Buffer.alloc(KNOWLEDGE_LIMITS.maxDocumentBytes + 10, 0x61))
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: oversizedFile,
          allowedRootDir: allowedDir,
        }),
      KnowledgeValidationError,
    )

    // Credential in file content rejected with zero partial persistence
    const secretFile = join(allowedDir, 'secret-key.txt')
    writeFileSync(secretFile, 'API_KEY=sk-proj-1234567890abcdef1234', { mode: 0o600 })
    await assert.rejects(
      () =>
        pipeline.ingestFile(AUTH, {
          scope: { kind: 'workspace', userId: 'user-1', workspaceId: 'ws-1' },
          filePath: secretFile,
          allowedRootDir: allowedDir,
        }),
      (err: unknown) => {
        assert.ok(err instanceof KnowledgeCredentialError)
        assert.equal(err.message.includes('1234567890'), false)
        return true
      },
    )
    assert.equal(repo.listDocuments(AUTH).total, 1)

    // Permissive existing DB directory rejected without mutating its mode
    const permDir = join(rootDir, 'perm-dir')
    mkdirSync(permDir, { mode: 0o755 })
    chmodSync(permDir, 0o755)
    await assert.rejects(
      () => openKnowledgeDatabase(join(permDir, 'knowledge.sqlite')),
      KnowledgeUnsafePathError,
    )
    assert.equal(statSync(permDir).mode & 0o777, 0o755)
  } finally {
    repo.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})
