import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import { DISCOVERY_LIMITS } from '../apps/daemon/src/workspace/discovery-contracts.ts'

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'ghost-bot-discovery-'))
  const root = join(parent, 'workspace')
  await mkdir(root)
  const db = await openGhostBotDatabase(join(parent, 'data'))
  const botId = 'search-bot'
  const now = new Date().toISOString()
  db.sqlite.prepare(
    `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort,
                         workspace_path, permission_mode, created_at, updated_at)
     VALUES (?, 'Search', '', '', '{}', 'mock', 'mock-model', 'medium', ?, 'read-only', ?, ?)`,
  ).run(botId, root, now, now)
  const service = new WorkspaceFilesService(db)
  const context = await service.resolveContext({ botId })
  assert.ok(context.workspaceId && context.authGeneration)
  return {
    db, root, parent, service,
    access: { botId, workspaceId: context.workspaceId, authGeneration: context.authGeneration },
    close: async () => {
      db.close()
      await rm(parent, { recursive: true, force: true })
    },
  }
}

test('workspace search returns file names and bounded matching lines from the same authorized root', async () => {
  const ctx = await fixture()
  try {
    await mkdir(join(ctx.root, 'docs'))
    await writeFile(join(ctx.root, 'docs', 'Needle.md'), 'First line\r\nA Needle match\r\n')
    await writeFile(join(ctx.root, '.env'), 'needle hidden')
    await writeFile(join(ctx.parent, 'outside.txt'), 'needle outside')
    await symlink(join(ctx.parent, 'outside.txt'), join(ctx.root, 'needle-link.txt'))
    const request = { ...ctx.access, operationId: randomUUID(), query: 'needle' }
    const names = await ctx.service.searchFiles({ ...request, mode: 'filename' })
    assert.deepEqual(names.results, [{ relativePath: 'docs/Needle.md', lineNumber: null, line: null }])
    assert.equal(names.operationId, request.operationId)
    const text = await ctx.service.searchFiles({ ...request, mode: 'content' })
    assert.deepEqual(text.results, [{ relativePath: 'docs/Needle.md', lineNumber: 2, line: 'A Needle match' }])
    assert.equal(text.authGeneration, ctx.access.authGeneration)
    await assert.rejects(ctx.service.searchFiles({ ...request, mode: 'content', teamId: 'team' }))
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(ctx.service.searchFiles({ ...request, mode: 'content' }, controller.signal), {
      name: 'AbortError',
    })

    ctx.db.sqlite.prepare("UPDATE agents SET updated_at = '2030-01-01' WHERE id = ?").run(ctx.access.botId)
    await assert.rejects(ctx.service.searchFiles({ ...request, mode: 'content' }), {
      code: 'WORKSPACE_CONTEXT_MISMATCH',
    })
  } finally {
    await ctx.close()
  }
})

test('content search caps result count, line length, file size and directory depth', async () => {
  const ctx = await fixture()
  try {
    await writeFile(join(ctx.root, 'matches.txt'), `${'x'.repeat(420)} needle\n`.repeat(130))
    await writeFile(join(ctx.root, 'oversized.txt'), 'needle'.repeat(12_000))
    const deep = Array.from({ length: DISCOVERY_LIMITS.maxDepth + 1 }, (_, i) => `d${i}`)
    await mkdir(join(ctx.root, ...deep), { recursive: true })
    await writeFile(join(ctx.root, ...deep, 'needle.txt'), 'needle')
    const input = { ...ctx.access, operationId: randomUUID(), query: 'needle' }
    const content = await ctx.service.searchFiles({ ...input, mode: 'content' })
    assert.equal(content.results.length, DISCOVERY_LIMITS.maxResults)
    assert.equal(content.truncated, true)
    assert.ok(content.results.every(({ line }) => line?.includes('needle') && line.length <= DISCOVERY_LIMITS.maxLineLength))
    const names = await ctx.service.searchFiles({ ...input, mode: 'filename' })
    assert.deepEqual(names.results, [])
    assert.equal(names.truncated, true)
  } finally {
    await ctx.close()
  }
})

test('preview peeks only bounded and correctly typed content through workspace descriptors', async () => {
  const ctx = await fixture()
  try {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XEAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(join(ctx.root, 'test.png'), png)
    await writeFile(join(ctx.root, 'fake.png'), '<svg onload="alert(1)"/>')
    await writeFile(join(ctx.root, 'notes.md'), '# Heading\n<script>ignored in renderer</script>')
    await writeFile(join(ctx.root, 'test.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>')
    await writeFile(join(ctx.root, 'big.md'), Buffer.alloc(DISCOVERY_LIMITS.maxPreviewBytes + 1, 'x'))
    await writeFile(join(ctx.root, '.env'), 'fixture')
    await symlink(join(ctx.root, 'notes.md'), join(ctx.root, 'linked.md'))
    const preview = (relativePath: string) => ctx.service.previewFile({ ...ctx.access, relativePath })
    assert.deepEqual((await preview('test.png')).preview, {
      kind: 'image', mime: 'image/png', base64: png.toString('base64'),
    })
    assert.equal((await preview('fake.png')).preview.kind, 'unavailable')
    assert.equal((await preview('notes.md')).preview.kind, 'markdown')
    assert.equal((await preview('test.svg')).preview.kind, 'svg')
    assert.equal((await preview('test.pdf')).preview.kind, 'unavailable')
    await assert.rejects(preview('big.md'), { code: 'FILE_TOO_LARGE' })
    await assert.rejects(preview('.env'), { code: 'SENSITIVE_FILE_BLOCKED' })
    await assert.rejects(preview('linked.md'), { code: 'SYMLINK_REJECTED' })
  } finally {
    await ctx.close()
  }
})
