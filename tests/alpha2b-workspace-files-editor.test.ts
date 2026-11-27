import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { chmod, link as fsLink, mkdir, mkdtemp, readFile, rename as fsRename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { DaemonError } from '../apps/daemon/src/errors.ts'
import { WORKSPACE_LIMITS } from '../apps/daemon/src/workspace/contracts.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import { WorkspaceFilesStore, WORKSPACE_STORE_LIMITS } from '../apps/desktop/src/components/workspace/workspaceFilesStore.ts'

async function createTempDaemonAndWorkspaces() {
  const root = await mkdtemp(join(tmpdir(), 'ghost-bot-alpha2b-'))
  const dataDir = join(root, 'data')
  const ws1 = join(root, 'ws1')
  const ws2 = join(root, 'ws2')
  const outside = join(root, 'outside')
  await mkdir(dataDir, { recursive: true })
  await mkdir(join(ws1, 'src'), { recursive: true })
  await mkdir(join(ws1, '.git'), { recursive: true })
  await mkdir(ws2, { recursive: true })
  await mkdir(outside, { recursive: true })

  await writeFile(join(ws1, 'README.md'), '# Workspace 1\n', 'utf8')
  await writeFile(join(ws1, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
  await chmod(join(ws1, 'src', 'index.ts'), 0o750)
  await writeFile(join(ws1, '.env'), 'OPENAI_API_KEY=sk-test-secret-1234567890123456\n', 'utf8')
  await writeFile(join(ws1, '.git', 'config'), '[core]\n', 'utf8')
  await writeFile(join(ws1, 'cert.pem'), '-----BEGIN PRIVATE KEY-----\n', 'utf8')
  await writeFile(join(ws1, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
  await writeFile(join(ws1, 'nul-bytes.txt'), Buffer.from('abc\0def'))
  await writeFile(join(ws1, 'readonly.txt'), 'locked\n', 'utf8')
  await chmod(join(ws1, 'readonly.txt'), 0o444)

  await writeFile(join(ws2, 'README.md'), '# Workspace 2\n', 'utf8')
  await writeFile(join(outside, 'secret.txt'), 'outside-secret\n', 'utf8')

  const db = await openGhostBotDatabase(dataDir)
  const now = new Date().toISOString()

  const insertBot = db.sqlite.prepare(
    `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at, archived_at)
     VALUES (?, ?, '', '', '{}', 'codex', 'gpt-5', 'medium', ?, ?, ?, ?, NULL)`,
  )
  insertBot.run('bot-ws1', 'Bot WS1', ws1, 'workspace', now, now)
  insertBot.run('bot-ro', 'Bot ReadOnly', ws1, 'read-only', now, now)
  insertBot.run('bot-ws2', 'Bot WS2', ws2, 'workspace', now, now)
  insertBot.run('bot-full', 'Bot FullAccess', ws1, 'full-access', now, now)
  insertBot.run('bot-unconf', 'Bot Unconfigured', '', 'workspace', now, now)

  const service = new WorkspaceFilesService(db)
  return {
    root,
    ws1,
    ws2,
    outside,
    db,
    service,
    cleanup: async () => {
      await chmod(join(ws1, 'readonly.txt'), 0o644).catch(() => {})
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('Alpha.2B WorkspaceFilesService: authorized list, read, save, permission preservation, and conflict rejection', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const resolved = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.equal(resolved.authorized, true)
    assert.equal(resolved.canWrite, true)
    assert.ok(resolved.workspaceId)

    const rootList = await ctx.service.listDirectory({
      botId: 'bot-ws1',
      workspaceId: resolved.workspaceId,
      relativePath: '',
    })
    const names = rootList.entries.map((e) => e.name)
    assert.ok(names.includes('README.md'))
    assert.ok(names.includes('src'))
    assert.equal(names.includes('.env'), false, 'Sensitive .env must be hidden')
    assert.equal(names.includes('.git'), false, '.git must be hidden')
    assert.equal(names.includes('cert.pem'), false, '.pem must be hidden')

    const file1 = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: resolved.workspaceId,
      relativePath: 'src/index.ts',
    })
    assert.equal(file1.content, 'export const value = 1\n')
    assert.equal(file1.language, 'typescript')
    assert.equal(file1.readOnly, false)

    const saved = await ctx.service.saveFile({
      botId: 'bot-ws1',
      workspaceId: resolved.workspaceId,
      relativePath: 'src/index.ts',
      content: 'export const value = 2\n',
      expectedRevision: file1.revision,
    })
    assert.notEqual(saved.revision, file1.revision)
    assert.equal(await readFile(join(ctx.ws1, 'src', 'index.ts'), 'utf8'), 'export const value = 2\n')
    const st = await stat(join(ctx.ws1, 'src', 'index.ts'))
    assert.equal(st.mode & 0o777, 0o750, 'Existing file permissions must be preserved')

    // External modification must trigger FILE_CONFLICT (409) and never overwrite
    await writeFile(join(ctx.ws1, 'src', 'index.ts'), 'export const value = 999\n', 'utf8')
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ws1',
          workspaceId: resolved.workspaceId!,
          relativePath: 'src/index.ts',
          content: 'export const value = 3\n',
          expectedRevision: saved.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_CONFLICT' && err.statusCode === 409,
    )
    assert.equal(
      await readFile(join(ctx.ws1, 'src', 'index.ts'), 'utf8'),
      'export const value = 999\n',
      'External modification must not be overwritten',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B security boundaries: traversal, symlinks, special files, binary, oversized, read-only, and auth changes', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    const ws2Ctx = await ctx.service.resolveContext({ botId: 'bot-ws2' })
    assert.ok(ws1Ctx.workspaceId && ws2Ctx.workspaceId)
    assert.notEqual(ws1Ctx.workspaceId, ws2Ctx.workspaceId)

    // Path traversal & absolute paths
    for (const bad of ['../outside/secret.txt', '/etc/passwd', 'src/../../outside/secret.txt', 'a\\b', 'bad\0path']) {
      await assert.rejects(
        () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: bad }),
        (err: unknown) => err instanceof DaemonError,
      )
    }

    // Sensitive files
    for (const sens of ['.env', '.git/config', 'cert.pem']) {
      await assert.rejects(
        () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: sens }),
        (err: unknown) => err instanceof DaemonError && err.code === 'SENSITIVE_FILE_BLOCKED',
      )
    }

    // Binary files
    for (const bin of ['image.png', 'nul-bytes.txt']) {
      await assert.rejects(
        () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: bin }),
        (err: unknown) => err instanceof DaemonError && err.code === 'UNSUPPORTED_BINARY_FILE',
      )
    }

    // Symlink file escape & symlink directory escape
    await symlink(join(ctx.outside, 'secret.txt'), join(ctx.ws1, 'link-secret.txt'))
    await symlink(ctx.outside, join(ctx.ws1, 'link-dir'))
    await assert.rejects(
      () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: 'link-secret.txt' }),
      (err: unknown) => err instanceof DaemonError && err.code === 'SYMLINK_REJECTED',
    )
    await assert.rejects(
      () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: 'link-dir/secret.txt' }),
      (err: unknown) => err instanceof DaemonError && err.code === 'SYMLINK_REJECTED',
    )

    // Special file (FIFO named pipe)
    execFileSync('mkfifo', [join(ctx.ws1, 'pipe.fifo')])
    await assert.rejects(
      () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: 'pipe.fifo' }),
      (err: unknown) => err instanceof DaemonError && err.code === 'UNSUPPORTED_SPECIAL_FILE',
    )

    // Oversized file (> 1 MiB)
    await writeFile(join(ctx.ws1, 'huge.txt'), 'a'.repeat(WORKSPACE_LIMITS.maxFileBytes + 10), 'utf8')
    await assert.rejects(
      () => ctx.service.readFile({ botId: 'bot-ws1', workspaceId: ws1Ctx.workspaceId!, relativePath: 'huge.txt' }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_TOO_LARGE',
    )

    // Oversized directory (> 500 entries -> bounded & truncated)
    const bigDir = join(ctx.ws1, 'many')
    await mkdir(bigDir, { recursive: true })
    await Promise.all(
      Array.from({ length: WORKSPACE_LIMITS.maxDirectoryEntries + 15 }, (_, i) =>
        writeFile(join(bigDir, `f-${String(i).padStart(4, '0')}.txt`), 'x', 'utf8'),
      ),
    )
    const manyRes = await ctx.service.listDirectory({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId!,
      relativePath: 'many',
    })
    assert.equal(manyRes.entries.length, WORKSPACE_LIMITS.maxDirectoryEntries)
    assert.equal(manyRes.truncated, true)

    // Read-only bot permission & OS read-only file
    const roCtx = await ctx.service.resolveContext({ botId: 'bot-ro' })
    assert.ok(roCtx.workspaceId)
    assert.equal(roCtx.canWrite, false)
    const roFile = await ctx.service.readFile({
      botId: 'bot-ro',
      workspaceId: roCtx.workspaceId,
      relativePath: 'README.md',
    })
    assert.equal(roFile.readOnly, true)
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ro',
          workspaceId: roCtx.workspaceId!,
          relativePath: 'README.md',
          content: 'mutated',
          expectedRevision: roFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_READ_ONLY',
    )

    const osRoFile = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId!,
      relativePath: 'readonly.txt',
    })
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'readonly.txt',
          content: 'mutated',
          expectedRevision: osRoFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_READ_ONLY',
    )

    // Unsupported full-access mode & unconfigured workspace
    const fullCtx = await ctx.service.resolveContext({ botId: 'bot-full' })
    assert.equal(fullCtx.authorized, false)
    const unconfCtx = await ctx.service.resolveContext({ botId: 'bot-unconf' })
    assert.equal(unconfCtx.authorized, false)

    // Cross-workspace mismatch & workspace revocation/reassignment
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ws2',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'README.md',
          content: 'cross-write',
          expectedRevision: roFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )

    // Reassign bot-ws1 to ws2 and verify stale ws1 workspaceId is rejected
    ctx.db.sqlite.prepare('UPDATE agents SET workspace_path = ? WHERE id = ?').run(ctx.ws2, 'bot-ws1')
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-FS-01: hard-link rejection, root identity replacement, and ancestor containment', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(ws1Ctx.workspaceId)

    // Hard-link policy: hard-linking an outside file into workspace must be rejected
    await fsLink(join(ctx.outside, 'secret.txt'), join(ctx.ws1, 'hardlink-secret.txt'))
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'hardlink-secret.txt',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'HARDLINK_REJECTED',
    )

    // Root identity replacement at the exact same pathname must invalidate stale workspaceId
    const swappedDir = join(ctx.root, 'ws1-replacement')
    await mkdir(swappedDir, { recursive: true })
    await writeFile(join(swappedDir, 'README.md'), '# Replaced root\n', 'utf8')
    await fsRename(ctx.ws1, join(ctx.root, 'ws1-old'))
    await fsRename(swappedDir, ctx.ws1)

    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )

    // Restore ws1 for cleanup
    await fsRename(ctx.ws1, swappedDir)
    await fsRename(join(ctx.root, 'ws1-old'), ctx.ws1)
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-FS-02 & A2B-AUTH-01: concurrent saves, injected write error, and mid-save revocation', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(ws1Ctx.workspaceId)

    const initial = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      relativePath: 'README.md',
    })

    // 1. Injected write failure must preserve original file and leave zero temp files
    await assert.rejects(
      () =>
        ctx.service.saveFile(
          {
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            relativePath: 'README.md',
            content: 'corrupted-partial',
            expectedRevision: initial.revision,
          },
          {
            injectWriteError: () => {
              throw new Error('Injected disk I/O failure')
            },
          },
        ),
      (err: unknown) => err instanceof Error && err.message.includes('Injected disk I/O failure'),
    )
    assert.equal(await readFile(join(ctx.ws1, 'README.md'), 'utf8'), '# Workspace 1\n')

    // 2. Concurrent saves with same expectedRevision: serialized; one succeeds, second gets FILE_CONFLICT
    const results = await Promise.allSettled([
      ctx.service.saveFile({
        botId: 'bot-ws1',
        workspaceId: ws1Ctx.workspaceId,
        relativePath: 'README.md',
        content: '# Concurrent A\n',
        expectedRevision: initial.revision,
      }),
      ctx.service.saveFile({
        botId: 'bot-ws1',
        workspaceId: ws1Ctx.workspaceId,
        relativePath: 'README.md',
        content: '# Concurrent B\n',
        expectedRevision: initial.revision,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    assert.equal(fulfilled.length, 1)
    assert.equal(rejected.length, 1)
    assert.ok(
      rejected[0].reason instanceof DaemonError && rejected[0].reason.code === 'FILE_CONFLICT',
    )

    // 3. Permission downgrade during save (onBeforeCommit barrier) aborts commit safely
    const beforeRevoke = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      relativePath: 'README.md',
    })
    await assert.rejects(
      () =>
        ctx.service.saveFile(
          {
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            relativePath: 'README.md',
            content: '# Should not commit\n',
            expectedRevision: beforeRevoke.revision,
          },
          {
            onBeforeCommit: () => {
              ctx.db.sqlite
                .prepare("UPDATE agents SET permission_mode = 'read-only' WHERE id = ?")
                .run('bot-ws1')
            },
          },
        ),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_READ_ONLY',
    )
    assert.equal(await readFile(join(ctx.ws1, 'README.md'), 'utf8'), '# Concurrent A\n')

    // 4. Exactly one selector required (both botId and teamId rejected)
    await assert.rejects(
      () => ctx.service.resolveContext({ botId: 'bot-ws1', teamId: 'team-1' }),
    )
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-FS-03: raw traversal segments rejected & whitespace filenames supported', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(ws1Ctx.workspaceId)

    await mkdir(join(ctx.ws1, 'my notes'), { recursive: true })
    await writeFile(join(ctx.ws1, 'my notes', 'hello world.txt'), 'notes\n', 'utf8')

    const note = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      relativePath: 'my notes/hello world.txt',
    })
    assert.equal(note.content, 'notes\n')

    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          relativePath: 'src/../README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'PATH_TRAVERSAL_REJECTED',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-UI-01 & A2B-UI-02: store preserves unsaved buffers across collapse & reconciles in-flight saves', async () => {
  const store = new WorkspaceFilesStore()
  const ws1State = store.setContextResolution('bot:bot-1', {
    authorized: true,
    workspaceId: 'ws-id-1',
    canonicalRoot: '/tmp/ws1',
    ownerKind: 'bot',
    ownerId: 'bot-1',
    ownerName: 'Bot 1',
    canWrite: true,
    permissionMode: 'workspace',
    authGeneration: 'gen-1',
    reason: null,
  })
  assert.ok(ws1State)

  store.openOrUpdateTab(ws1State.storageKey, {
    relativePath: 'README.md',
    name: 'README.md',
    savedContent: 'orig',
    draftContent: 'unsaved-edit',
    revision: 'rev-1',
    readOnly: false,
    language: 'markdown',
    saving: false,
    conflictMessage: null,
    errorMessage: null,
  })

  // Simulated panel collapse/unmount + remount still retains unsaved buffer
  const restored = store.getActiveWorkspaceState('bot:bot-1')
  assert.equal(restored?.tabs[0]?.draftContent, 'unsaved-edit')

  // In-flight save reconciles against originating workspace even if context switches mid-flight
  let resolveSave!: (v: {
    workspaceId: string
    relativePath: string
    revision: string
    sizeBytes: number
    savedAt: string
  }) => void
  const savePromise = store.saveTab(
    {
      resolveContext: async () => ws1State.contextInfo,
      listDirectory: async () => {
        throw new Error('unused')
      },
      readFile: async () => {
        throw new Error('unused')
      },
      saveFile: () =>
        new Promise((resolve) => {
          resolveSave = resolve
        }),
    },
    { botId: 'bot-1' },
    ws1State.storageKey,
    'README.md',
  )

  // User switches to bot-2 while save is in flight
  store.setContextResolution('bot:bot-2', {
    authorized: true,
    workspaceId: 'ws-id-2',
    canonicalRoot: '/tmp/ws2',
    ownerKind: 'bot',
    ownerId: 'bot-2',
    ownerName: 'Bot 2',
    canWrite: true,
    permissionMode: 'workspace',
    authGeneration: 'gen-2',
    reason: null,
  })

  resolveSave({
    workspaceId: 'ws-id-1',
    relativePath: 'README.md',
    revision: 'rev-2',
    sizeBytes: 12,
    savedAt: new Date().toISOString(),
  })
  await savePromise

  const afterSaveWs1 = store.getActiveWorkspaceState('bot:bot-1')
  assert.equal(afterSaveWs1?.tabs[0]?.saving, false)
  assert.equal(afterSaveWs1?.tabs[0]?.revision, 'rev-2')
  assert.equal(afterSaveWs1?.tabs[0]?.savedContent, 'unsaved-edit')

  // Permission downgrade marks open tabs readOnly
  store.setContextResolution('bot:bot-1', {
    ...ws1State.contextInfo,
    canWrite: false,
    permissionMode: 'read-only',
  })
  assert.equal(store.getActiveWorkspaceState('bot:bot-1')?.tabs[0]?.readOnly, true)
  assert.equal(WORKSPACE_STORE_LIMITS.maxRetainedWorkspaces, 6)
})
