import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import {
  chmod,
  link as fsLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { DaemonError } from '../apps/daemon/src/errors.ts'
import { WORKSPACE_LIMITS } from '../apps/daemon/src/workspace/contracts.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import {
  WORKSPACE_STORE_LIMITS,
  WorkspaceFilesStore,
} from '../apps/desktop/src/components/workspace/workspaceFilesStore.ts'

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
  insertBot.run('bot-shared-ws1', 'Bot Shared WS1', ws1, 'workspace', now, now)
  insertBot.run('bot-nested-src', 'Bot Nested Src', join(ws1, 'src'), 'workspace', now, now)
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
    assert.ok(resolved.workspaceId && resolved.authGeneration)

    const rootList = await ctx.service.listDirectory({
      botId: 'bot-ws1',
      workspaceId: resolved.workspaceId,
      authGeneration: resolved.authGeneration,
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
      authGeneration: resolved.authGeneration,
      relativePath: 'src/index.ts',
    })
    assert.equal(file1.content, 'export const value = 1\n')
    assert.equal(file1.language, 'typescript')
    assert.equal(file1.readOnly, false)

    const saved = await ctx.service.saveFile({
      botId: 'bot-ws1',
      workspaceId: resolved.workspaceId,
      authGeneration: resolved.authGeneration,
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
          authGeneration: resolved.authGeneration!,
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
    assert.ok(ws1Ctx.workspaceId && ws1Ctx.authGeneration && ws2Ctx.workspaceId && ws2Ctx.authGeneration)
    assert.notEqual(ws1Ctx.workspaceId, ws2Ctx.workspaceId)

    for (const bad of ['../outside/secret.txt', '/etc/passwd', 'src/../../outside/secret.txt', 'a\\b', 'bad\0path']) {
      await assert.rejects(
        () =>
          ctx.service.readFile({
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            authGeneration: ws1Ctx.authGeneration!,
            relativePath: bad,
          }),
        (err: unknown) => err instanceof DaemonError,
      )
    }

    for (const sens of ['.env', '.git/config', 'cert.pem']) {
      await assert.rejects(
        () =>
          ctx.service.readFile({
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            authGeneration: ws1Ctx.authGeneration!,
            relativePath: sens,
          }),
        (err: unknown) => err instanceof DaemonError && err.code === 'SENSITIVE_FILE_BLOCKED',
      )
    }

    for (const bin of ['image.png', 'nul-bytes.txt']) {
      await assert.rejects(
        () =>
          ctx.service.readFile({
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            authGeneration: ws1Ctx.authGeneration!,
            relativePath: bin,
          }),
        (err: unknown) => err instanceof DaemonError && err.code === 'UNSUPPORTED_BINARY_FILE',
      )
    }

    await symlink(join(ctx.outside, 'secret.txt'), join(ctx.ws1, 'link-secret.txt'))
    await symlink(ctx.outside, join(ctx.ws1, 'link-dir'))
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'link-secret.txt',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'SYMLINK_REJECTED',
    )
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'link-dir/secret.txt',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'SYMLINK_REJECTED',
    )

    execFileSync('mkfifo', [join(ctx.ws1, 'pipe.fifo')])
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'pipe.fifo',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'UNSUPPORTED_SPECIAL_FILE',
    )

    await writeFile(join(ctx.ws1, 'huge.txt'), 'a'.repeat(WORKSPACE_LIMITS.maxFileBytes + 10), 'utf8')
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'huge.txt',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_TOO_LARGE',
    )

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
      authGeneration: ws1Ctx.authGeneration!,
      relativePath: 'many',
    })
    assert.equal(manyRes.entries.length, WORKSPACE_LIMITS.maxDirectoryEntries)
    assert.equal(manyRes.truncated, true)

    const roCtx = await ctx.service.resolveContext({ botId: 'bot-ro' })
    assert.ok(roCtx.workspaceId && roCtx.authGeneration)
    assert.equal(roCtx.canWrite, false)
    const roFile = await ctx.service.readFile({
      botId: 'bot-ro',
      workspaceId: roCtx.workspaceId,
      authGeneration: roCtx.authGeneration,
      relativePath: 'README.md',
    })
    assert.equal(roFile.readOnly, true)
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ro',
          workspaceId: roCtx.workspaceId!,
          authGeneration: roCtx.authGeneration!,
          relativePath: 'README.md',
          content: 'mutated',
          expectedRevision: roFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_READ_ONLY',
    )

    const osRoFile = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId!,
      authGeneration: ws1Ctx.authGeneration!,
      relativePath: 'readonly.txt',
    })
    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'readonly.txt',
          content: 'mutated',
          expectedRevision: osRoFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_READ_ONLY',
    )

    const fullCtx = await ctx.service.resolveContext({ botId: 'bot-full' })
    assert.equal(fullCtx.authorized, false)
    const unconfCtx = await ctx.service.resolveContext({ botId: 'bot-unconf' })
    assert.equal(unconfCtx.authorized, false)

    await assert.rejects(
      () =>
        ctx.service.saveFile({
          botId: 'bot-ws2',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'README.md',
          content: 'cross-write',
          expectedRevision: roFile.revision,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )

    ctx.db.sqlite.prepare('UPDATE agents SET workspace_path = ? WHERE id = ?').run(ctx.ws2, 'bot-ws1')
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-FS-01: hard-link rejection, root identity replacement, and directory relocation', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(ws1Ctx.workspaceId && ws1Ctx.authGeneration)

    await fsLink(join(ctx.outside, 'secret.txt'), join(ctx.ws1, 'hardlink-secret.txt'))
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'hardlink-secret.txt',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'HARDLINK_REJECTED',
    )

    // Root identity replacement at same path invalidates workspaceId
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
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_CONTEXT_MISMATCH',
    )

    // Directory relocation (missing at configured path) fails closed
    await fsRename(ctx.ws1, swappedDir)
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_UNAVAILABLE',
    )

    await fsRename(join(ctx.root, 'ws1-old'), ctx.ws1)
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 Final Closure: cross-bot physical file serialization, external mod during staging, stale authGeneration, and mid-save revocation', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    const sharedCtx = await ctx.service.resolveContext({ botId: 'bot-shared-ws1' })
    assert.ok(ws1Ctx.workspaceId && ws1Ctx.authGeneration)
    assert.ok(sharedCtx.workspaceId && sharedCtx.authGeneration)

    const initial = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      authGeneration: ws1Ctx.authGeneration,
      relativePath: 'README.md',
    })

    // 1. Injected write failure preserves original file & cleans up temp file
    await assert.rejects(
      () =>
        ctx.service.saveFile(
          {
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            authGeneration: ws1Ctx.authGeneration!,
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
    const leftoversAfterErr = (await readdir(ctx.ws1)).filter((n) => n.startsWith('.ghost-tmp-'))
    assert.deepEqual(leftoversAfterErr, [])

    // 2. Cross-bot concurrent saves to the SAME physical file serialize cleanly: 1 succeeds, 1 gets FILE_CONFLICT
    const results = await Promise.allSettled([
      ctx.service.saveFile({
        botId: 'bot-ws1',
        workspaceId: ws1Ctx.workspaceId,
        authGeneration: ws1Ctx.authGeneration,
        relativePath: 'README.md',
        content: '# Bot1 Write\n',
        expectedRevision: initial.revision,
      }),
      ctx.service.saveFile({
        botId: 'bot-shared-ws1',
        workspaceId: sharedCtx.workspaceId,
        authGeneration: sharedCtx.authGeneration,
        relativePath: 'README.md',
        content: '# SharedBot Write\n',
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

    // 3. External modification DURING staging (between temp write and rename) triggers pre-commit FILE_CONFLICT
    const beforeStaging = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      authGeneration: ws1Ctx.authGeneration,
      relativePath: 'README.md',
    })
    await assert.rejects(
      () =>
        ctx.service.saveFile(
          {
            botId: 'bot-ws1',
            workspaceId: ws1Ctx.workspaceId!,
            authGeneration: ws1Ctx.authGeneration!,
            relativePath: 'README.md',
            content: '# Staged Overwrite Attempt\n',
            expectedRevision: beforeStaging.revision,
          },
          {
            onBeforeCommit: async () => {
              await writeFile(join(ctx.ws1, 'README.md'), '# External Writer During Staging\n', 'utf8')
            },
          },
        ),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_CONFLICT' && err.statusCode === 409,
    )
    assert.equal(
      await readFile(join(ctx.ws1, 'README.md'), 'utf8'),
      '# External Writer During Staging\n',
      'External modification during staging must not be overwritten',
    )

    // 4. Stale authGeneration token rejected after bot updated_at / permission change
    ctx.db.sqlite
      .prepare('UPDATE agents SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() + 1000).toISOString(), 'bot-ws1')
    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
          relativePath: 'README.md',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'STALE_AUTHORIZATION_TOKEN',
    )

    // 5. Permission downgrade during save (onBeforeCommit) aborts with WORKSPACE_READ_ONLY
    const refreshedCtx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(refreshedCtx.workspaceId && refreshedCtx.authGeneration)
    const beforeRevoke = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: refreshedCtx.workspaceId,
      authGeneration: refreshedCtx.authGeneration,
      relativePath: 'README.md',
    })
    await assert.rejects(
      () =>
        ctx.service.saveFile(
          {
            botId: 'bot-ws1',
            workspaceId: refreshedCtx.workspaceId!,
            authGeneration: refreshedCtx.authGeneration!,
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
    assert.equal(
      await readFile(join(ctx.ws1, 'README.md'), 'utf8'),
      '# External Writer During Staging\n',
    )

    await assert.rejects(
      () => ctx.service.resolveContext({ botId: 'bot-ws1', teamId: 'team-1' }),
    )

    // 6. Nested workspace roots serialize saves to the same physical file (ws1/src/index.ts vs nested src/index.ts)
    const refreshedWs1 = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    const nestedCtx = await ctx.service.resolveContext({ botId: 'bot-nested-src' })
    assert.ok(refreshedWs1.workspaceId && refreshedWs1.authGeneration)
    assert.ok(nestedCtx.workspaceId && nestedCtx.authGeneration)
    const nestedInitial = await ctx.service.readFile({
      botId: 'bot-nested-src',
      workspaceId: nestedCtx.workspaceId,
      authGeneration: nestedCtx.authGeneration,
      relativePath: 'index.ts',
    })
    const nestedResults = await Promise.allSettled([
      ctx.service.saveFile({
        botId: 'bot-ws1',
        workspaceId: refreshedWs1.workspaceId,
        authGeneration: refreshedWs1.authGeneration,
        relativePath: 'src/index.ts',
        content: 'export const nested = "ws1"\n',
        expectedRevision: nestedInitial.revision,
      }),
      ctx.service.saveFile({
        botId: 'bot-nested-src',
        workspaceId: nestedCtx.workspaceId,
        authGeneration: nestedCtx.authGeneration,
        relativePath: 'index.ts',
        content: 'export const nested = "nested"\n',
        expectedRevision: nestedInitial.revision,
      }),
    ])
    assert.equal(nestedResults.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(nestedResults.filter((r) => r.status === 'rejected').length, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('Alpha.2B.1 A2B-FS-03: raw traversal segments rejected & whitespace filenames supported', async () => {
  const ctx = await createTempDaemonAndWorkspaces()
  try {
    const ws1Ctx = await ctx.service.resolveContext({ botId: 'bot-ws1' })
    assert.ok(ws1Ctx.workspaceId && ws1Ctx.authGeneration)

    await mkdir(join(ctx.ws1, 'my notes'), { recursive: true })
    await writeFile(join(ctx.ws1, 'my notes', 'hello world.txt'), 'notes\n', 'utf8')

    const note = await ctx.service.readFile({
      botId: 'bot-ws1',
      workspaceId: ws1Ctx.workspaceId,
      authGeneration: ws1Ctx.authGeneration,
      relativePath: 'my notes/hello world.txt',
    })
    assert.equal(note.content, 'notes\n')

    await assert.rejects(
      () =>
        ctx.service.readFile({
          botId: 'bot-ws1',
          workspaceId: ws1Ctx.workspaceId!,
          authGeneration: ws1Ctx.authGeneration!,
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

  const restored = store.getActiveWorkspaceState('bot:bot-1')
  assert.equal(restored?.tabs[0]?.draftContent, 'unsaved-edit')

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

  store.setContextResolution('bot:bot-1', {
    ...ws1State.contextInfo,
    canWrite: false,
    permissionMode: 'read-only',
  })
  assert.equal(store.getActiveWorkspaceState('bot:bot-1')?.tabs[0]?.readOnly, true)
  assert.equal(WORKSPACE_STORE_LIMITS.maxRetainedWorkspaces, 6)
})
