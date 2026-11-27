import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { DaemonError } from '../apps/daemon/src/errors.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import { WorkspaceOutputService } from '../apps/daemon/src/workspace/output-service.ts'

test('Alpha.2C.2 WorkspaceFilesService: atomic create, no-clobber rename, and quarantined delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-alpha2c2-svc-'))
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  await mkdir(dataDir, { recursive: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'existing.txt'), 'existing\n', 'utf8')

  const db = await openGhostBotDatabase(dataDir)
  try {
    const now = new Date().toISOString()
    db.sqlite
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at, archived_at)
         VALUES ('bot-w', 'Bot W', '', '', '{}', 'codex', 'gpt-5', 'medium', ?, 'workspace', ?, ?, NULL)`,
      )
      .run(ws, now, now)

    const service = new WorkspaceFilesService(db)
    const ctx = await service.resolveContext({ botId: 'bot-w' })
    assert.ok(ctx.workspaceId && ctx.authGeneration)

    // Create directory & file
    const dirRes = await service.createEntry({
      botId: 'bot-w',
      workspaceId: ctx.workspaceId,
      authGeneration: ctx.authGeneration,
      relativePath: 'notes',
      kind: 'directory',
    })
    assert.equal(dirRes.kind, 'directory')

    const fileRes = await service.createEntry({
      botId: 'bot-w',
      workspaceId: ctx.workspaceId,
      authGeneration: ctx.authGeneration,
      relativePath: 'notes/new.txt',
      kind: 'file',
      content: 'hello\n',
    })
    assert.equal(fileRes.kind, 'file')
    assert.ok(fileRes.revision)

    // No-clobber create rejects existing file
    await assert.rejects(
      () =>
        service.createEntry({
          botId: 'bot-w',
          workspaceId: ctx.workspaceId!,
          authGeneration: ctx.authGeneration!,
          relativePath: 'existing.txt',
          kind: 'file',
          content: 'clobber',
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'FILE_EXISTS',
    )

    // WRITE-03: rename is fail-closed gated with WORKSPACE_RENAME_GATED (501)
    await assert.rejects(
      () =>
        service.renameEntry({
          botId: 'bot-w',
          workspaceId: ctx.workspaceId!,
          authGeneration: ctx.authGeneration!,
          fromPath: 'notes/new.txt',
          toPath: 'notes/renamed.txt',
          expectedRevision: fileRes.revision!,
        }),
      (err: unknown) => err instanceof DaemonError && err.code === 'WORKSPACE_RENAME_GATED' && err.statusCode === 501,
    )
    assert.equal(await readFile(join(ws, 'notes', 'new.txt'), 'utf8'), 'hello\n')

    // WRITE-04: Quarantined delete moves file to .ghost-bot-trash (hidden from listing) & returns quarantinePath
    const deleted = await service.deleteFile({
      botId: 'bot-w',
      workspaceId: ctx.workspaceId,
      authGeneration: ctx.authGeneration,
      relativePath: 'notes/new.txt',
      expectedRevision: fileRes.revision!,
    })
    assert.equal(deleted.quarantined, true)
    assert.ok(deleted.quarantinePath?.startsWith('.ghost-bot-trash/'))
    const trashEntries = await readdir(join(ws, '.ghost-bot-trash'))
    assert.equal(trashEntries.length, 1)
    const trashStat = await stat(join(ws, '.ghost-bot-trash'))
    assert.equal(trashStat.mode & 0o077, 0)
    const listedRoot = await service.listDirectory({
      botId: 'bot-w',
      workspaceId: ctx.workspaceId,
      authGeneration: ctx.authGeneration,
      relativePath: '',
    })
    assert.equal(listedRoot.entries.some((e) => e.name === '.ghost-bot-trash'), false)

    // WRITE-04: Unsafe .ghost-bot-trash permissions (0o777) fail closed
    await writeFile(join(ws, 'notes', 'keep.txt'), 'keep\n', 'utf8')
    const keepOpened = await service.readFile({
      botId: 'bot-w',
      workspaceId: ctx.workspaceId,
      authGeneration: ctx.authGeneration,
      relativePath: 'notes/keep.txt',
    })
    await chmod(join(ws, '.ghost-bot-trash'), 0o777)
    await assert.rejects(
      () =>
        service.deleteFile({
          botId: 'bot-w',
          workspaceId: ctx.workspaceId!,
          authGeneration: ctx.authGeneration!,
          relativePath: 'notes/keep.txt',
          expectedRevision: keepOpened.revision,
        }),
      (err: unknown) =>
        err instanceof DaemonError && err.code === 'QUARANTINE_UNSAFE_PERMISSIONS' && err.statusCode === 403,
    )
    assert.equal(await readFile(join(ws, 'notes', 'keep.txt'), 'utf8'), 'keep\n')
    await chmod(join(ws, '.ghost-bot-trash'), 0o700)

    // WRITE-01: Write grant revocation serialized via writeGrantChecker + withOwnerMutationBarrier
    let writeAllowed = true
    service.setWriteGrantChecker(() => {
      if (!writeAllowed) {
        throw new DaemonError('WORKSPACE_WRITE_UNAUTHORIZED', 'Write grant revoked', { statusCode: 403 })
      }
    })
    await service.withOwnerMutationBarrier('bot-w', async () => {
      writeAllowed = false
    })
    await assert.rejects(
      () =>
        service.createEntry({
          botId: 'bot-w',
          workspaceId: ctx.workspaceId!,
          authGeneration: ctx.authGeneration!,
          relativePath: 'notes/revoked.txt',
          kind: 'file',
          content: 'blocked',
        }),
      (err: unknown) =>
        err instanceof DaemonError && err.code === 'WORKSPACE_WRITE_UNAUTHORIZED' && err.statusCode === 403,
    )
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Alpha.2C.2 Task 2 Output corrections: actual cancel outcomes, safe-field allowlist, and session scope', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha2c2-out-'))
  const db = await openGhostBotDatabase(dataDir)
  try {
    const now = new Date().toISOString()
    db.sqlite
      .prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at, archived_at)
         VALUES ('bot-1', 'Bot 1', '', '', '{}', 'codex', 'gpt-5', 'medium', ?, 'read-only', ?, ?, NULL)`,
      )
      .run(dataDir, now, now)
    db.sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, account_id, runtime_id, title, created_at, updated_at, archived_at)
         VALUES ('sess-1', 'bot-1', 'acc-1', 'codex', 'S1', ?, ?, NULL)`,
      )
      .run(now, now)
    db.sqlite
      .prepare(
        `INSERT INTO runs (id, session_id, agent_id, idempotency_key, runtime_id, model_id, effort, permission_mode, config_snapshot_json, status, error_json, started_at, ended_at, created_at)
         VALUES ('run-1', 'sess-1', 'bot-1', 'k1', 'codex', 'gpt-5', 'medium', 'read-only', '{}', 'running', NULL, ?, NULL, ?)`,
      )
      .run(now, now)
    db.sqlite
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, event_key, type, payload_json, timestamp)
         VALUES ('ev-1', 'run-1', 1, 'ek1', 'run.custom', ?, ?)`,
      )
      .run(JSON.stringify({ unlistedPrivateBlob: 'SHOULD_NOT_LEAK' }), now)

    const outSvc = new WorkspaceOutputService(db)
    const out = outSvc.listOutput({ botId: 'bot-1' })
    assert.equal(JSON.stringify(out).includes('SHOULD_NOT_LEAK'), false)

    // Mismatched sessionId rejected
    await assert.rejects(
      () =>
        outSvc.cancelExecution(
          { botId: 'bot-1', sessionId: 'other-session', runId: 'run-1' },
          { cancelRun: async () => ({ status: 'cancelled' }) },
        ),
      (err: unknown) => err instanceof DaemonError && err.code === 'OUTPUT_SESSION_UNAUTHORIZED',
    )

    // Actual interrupted outcome reflected as cancelled: false, status: 'uncertain'
    const cancelRes = await outSvc.cancelExecution(
      { botId: 'bot-1', sessionId: 'sess-1', runId: 'run-1' },
      { cancelRun: async () => ({ status: 'interrupted' }) },
    )
    assert.equal(cancelRes.cancelled, false)
    assert.equal(cancelRes.status, 'uncertain')
  } finally {
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Alpha.2C.2 Electron E2E: separate native write grant, create, save, rename, conflict, delete, and revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-alpha2c2-e2e-'))
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  await mkdir(dataDir, { recursive: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'readme.txt'), 'initial\n', 'utf8')

  const desktop = join(process.cwd(), 'apps', 'desktop')
  const app = await electron.launch({
    executablePath: join(desktop, 'node_modules', '.bin', 'electron'),
    args: [join(desktop, 'dist-electron', 'main.js')],
    cwd: desktop,
    env: {
      ...process.cwd(),
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    const botId = await page.evaluate(async (wsPath) => {
      const bridge = window.ghostBot!
      const { activeBotId } = await bridge.listBots()
      if (!activeBotId) throw new Error('Missing bot')
      await bridge.updateBot({ id: activeBotId, patch: { workspacePath: wsPath, permission: 'workspace' } })
      return activeBotId
    }, ws)

    await page.getByTestId('workspace-tab-files').click()
    await app.evaluate(({ dialog }, wsPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] })
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    }, ws)

    // Read grant alone keeps panel Read-only
    await page.getByRole('button', { name: 'Allow read access' }).click()
    await page.waitForSelector('[data-testid="workspace-files-permission-badge"]')
    assert.equal(await page.getByTestId('workspace-files-permission-badge').innerText(), 'Read-only')

    // Native write grant unlocks Writable state + file mutations
    await page.getByTestId('workspace-authorize-write-btn').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="workspace-files-permission-badge"]')?.textContent === 'Writable',
    )

    // Create file
    await page.getByTestId('workspace-new-file-btn').click()
    await page.getByTestId('workspace-create-input').fill('created.txt')
    await page.getByTestId('workspace-create-confirm-btn').click()
    await page.waitForSelector('[data-testid="workspace-editor-textarea"]')

    // Edit and Save
    const textarea = page.getByTestId('workspace-editor-textarea')
    await textarea.fill('updated-content\n')
    await page.getByTestId('editor-save-btn').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="editor-save-btn"]')?.hasAttribute('disabled'),
    )
    assert.equal(await readFile(join(ws, 'created.txt'), 'utf8'), 'updated-content\n')

    // WRITE-03: Rename button is gated/removed from editor toolbar
    assert.equal(await page.getByTestId('editor-rename-btn').count(), 0)

    // External modification triggers conflict & preserves dirty draft
    await writeFile(join(ws, 'created.txt'), 'external-change\n', 'utf8')
    await textarea.fill('dirty-draft\n')
    await page.getByTestId('editor-save-btn').click()
    await page.waitForSelector('[data-testid="editor-conflict-banner"]')
    assert.equal(await textarea.inputValue(), 'dirty-draft\n')
    await page.getByTestId('editor-conflict-reload-btn').click()
    await page.waitForFunction(
      () =>
        (document.querySelector('[data-testid="workspace-editor-textarea"]') as HTMLTextAreaElement | null)?.value ===
        'external-change\n',
    )

    // Delete into quarantine
    await page.getByTestId('editor-delete-btn').click()
    await page.getByTestId('editor-delete-confirm-btn').click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="workspace-tree-entry-created.txt"]'),
    )

    // Revoke write access and verify mutation fails closed
    await page.getByTestId('workspace-revoke-write-btn').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="workspace-files-permission-badge"]')?.textContent === 'Read-only',
    )
    const deniedAfterRevoke = await page.evaluate(async (id) => {
      const bridge = window.ghostBot!
      const ctx = await bridge.resolveWorkspaceContext({ botId: id })
      return bridge
        .createWorkspaceEntry({
          botId: id,
          workspaceId: ctx.workspaceId!,
          authGeneration: ctx.authGeneration!,
          relativePath: 'blocked.txt',
          kind: 'file',
          content: 'no',
        })
        .then(
          () => false,
          () => true,
        )
    }, botId)
    assert.equal(deniedAfterRevoke, true)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
