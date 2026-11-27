import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { DaemonError } from '../apps/daemon/src/errors.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import { WorkspaceOutputService } from '../apps/daemon/src/workspace/output-service.ts'

test('Alpha.2C.2 create uses no-clobber publication and preserves external entries', async () => {
  await withWorkspace(async ({ ws, service, access }) => {
    const create = { ...access, kind: 'file', relativePath: 'new.txt' }
    await assert.rejects(service.createEntry({ ...create, content: 'data' }), { code: 'WORKSPACE_CREATE_CONTENT_GATED' })
    assert.deepEqual(await readdir(ws), [])
    await assert.rejects(service.createEntry(create, {
      onBeforeCommit: () => writeFile(join(ws, 'new.txt'), 'external'),
    }), { code: 'FILE_EXISTS' })
    assert.equal(await readFile(join(ws, 'new.txt'), 'utf8'), 'external')

    const second = { ...create, relativePath: 'second.txt' }
    await assert.rejects(service.createEntry(second, {
      onAfterCommit: async () => {
        await rename(join(ws, 'second.txt'), join(ws, 'original'))
        await writeFile(join(ws, 'second.txt'), 'replacement')
      },
    }), { code: 'CREATE_OUTCOME_UNCERTAIN' })
    assert.equal(await readFile(join(ws, 'second.txt'), 'utf8'), 'replacement')
    assert.equal((await stat(join(ws, 'original'))).size, 0)

    await assert.rejects(service.createEntry({ ...create, relativePath: 'grown.txt' }, {
      onAfterCommit: () => writeFile(join(ws, 'grown.txt'), 'x'.repeat(2_000_000)),
    }), { code: 'CREATE_OUTCOME_UNCERTAIN' })
    assert.equal((await stat(join(ws, 'grown.txt'))).size, 2_000_000)

    assert.equal((await service.createEntry({ ...create, relativePath: 'empty.txt' })).sizeBytes, 0)
    assert.equal((await service.createEntry({ ...access, relativePath: 'notes', kind: 'directory' })).kind, 'directory')
    const moved = join(ws, 'relocated')
    await assert.rejects(service.createEntry({ ...create, relativePath: 'notes/moved.txt' }, {
      onBeforeCommit: async () => {
        await rename(join(ws, 'notes'), moved)
        await mkdir(join(ws, 'notes'))
      },
    }), { code: 'FILE_CONFLICT' })
    assert.deepEqual(await readdir(moved), [])
    assert.deepEqual(await readdir(join(ws, 'notes')), [])
  })
})

test('Alpha.2C.2 revocation, expiry, policy and root changes stop queued publication', async () => {
  for (const change of ['revoke', 'regrant', 'expire', 'policy', 'root'] as const) {
    await withWorkspace(async ({ root, ws, db, service, access }) => {
      let revoked = false
      let now = 0
      let grant = {}
      service.setWriteGrantChecker(() => {
        if (revoked || now >= 10) throw new DaemonError('WORKSPACE_WRITE_UNAUTHORIZED', 'Grant unavailable', { statusCode: 403 })
        return grant
      })
      const create = { ...access, kind: 'file', relativePath: 'blocked.txt' }
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const save = service.createEntry(create, {
        onBeforeCommit: async () => {
          started.resolve()
          await release.promise
        },
      })
      const rejected = assert.rejects(save, change === 'root' ? { code: 'WORKSPACE_CONTEXT_MISMATCH' } :
        change === 'policy' ? { code: 'WORKSPACE_READ_ONLY' } : { code: 'WORKSPACE_WRITE_UNAUTHORIZED' })
      await started.promise
      await service.withOwnerMutationBarrier(access.botId, async () => {
        if (change === 'revoke') revoked = true
        if (change === 'regrant') grant = {}
        if (change === 'expire') now = 10
        if (change === 'policy') db.sqlite.prepare("UPDATE agents SET permission_mode = 'read-only'").run()
        if (change === 'root') {
          await rename(ws, join(root, 'old'))
          await mkdir(ws)
        }
      })
      release.resolve()
      await rejected
      assert.deepEqual(await readdir(ws), [])
      if (change === 'root') assert.deepEqual(await readdir(join(root, 'old')), [])
    })
  }
})

test('Alpha.2C.2 rename and quarantine stay gated and preserve source and recovered files', async () => {
  await withWorkspace(async ({ ws, service, access }) => {
    await writeFile(join(ws, 'keep.txt'), 'original')
    const target = { ...access, relativePath: 'keep.txt' }
    const { revision } = await service.readFile(target)
    await assert.rejects(service.renameEntry({
      ...access, fromPath: 'keep.txt', toPath: 'renamed.txt', expectedRevision: revision,
    }), { code: 'WORKSPACE_RENAME_GATED' })
    await assert.rejects(service.deleteFile({ ...target, expectedRevision: revision }), { code: 'WORKSPACE_DELETE_GATED' })
    assert.deepEqual(await readdir(ws), ['keep.txt'])
    const quarantine = join(ws, '.ghost-bot-trash')
    await mkdir(quarantine, { mode: 0o700 })
    await writeFile(join(quarantine, 'recovered.txt'), 'recoverable')
    await assert.rejects(service.deleteFile({ ...target, expectedRevision: revision }), { code: 'WORKSPACE_DELETE_GATED' })
    assert.equal(await readFile(join(ws, 'keep.txt'), 'utf8'), 'original')
    assert.equal(await readFile(join(quarantine, 'recovered.txt'), 'utf8'), 'recoverable')
  })
})

async function withWorkspace(run: (fixture: {
  root: string
  ws: string
  db: Awaited<ReturnType<typeof openGhostBotDatabase>>
  service: WorkspaceFilesService
  access: { botId: string; workspaceId: string; authGeneration: string }
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'ghost-alpha2c2-svc-'))
  const ws = join(root, 'ws')
  await mkdir(ws)
  const db = await openGhostBotDatabase(join(root, 'data'))
  try {
    const now = new Date().toISOString()
    db.sqlite.prepare(
      `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort, workspace_path, permission_mode, created_at, updated_at, archived_at)
       VALUES ('bot-w', 'Bot W', '', '', '{}', 'codex', 'gpt-5', 'medium', ?, 'workspace', ?, ?, NULL)`,
    ).run(ws, now, now)
    const service = new WorkspaceFilesService(db)
    const fixtureGrant = {}
    service.setWriteGrantChecker(() => fixtureGrant)
    const botId = 'bot-w'
    const { workspaceId, authGeneration } = await service.resolveContext({ botId })
    assert.ok(workspaceId && authGeneration)
    await run({ root, ws, db, service, access: { botId, workspaceId, authGeneration } })
  } finally {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
}

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

test('Alpha.2C.2 Electron E2E: native consent, create, save, watch, dirty draft and revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-alpha2c2-e2e-'))
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  await mkdir(dataDir, { recursive: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'readme.txt'), 'initial\n', 'utf8')

  const app = await launchWorkspaceElectron(dataDir)

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

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    })
    assert.equal(await page.evaluate((id) => window.ghostBot!.authorizeWorkspaceWrite(id), botId), false)
    assert.equal(await page.getByTestId('workspace-files-permission-badge').innerText(), 'Read-only')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })

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

    await writeFile(join(ws, 'created.txt'), 'external-clean\n', 'utf8')
    await page.waitForFunction(() =>
      document.querySelector<HTMLTextAreaElement>('[data-testid="workspace-editor-textarea"]')?.value === 'external-clean\n',
    )
    await textarea.fill('dirty-draft\n')
    await writeFile(join(ws, 'created.txt'), 'external-dirty\n', 'utf8')
    await page.getByTestId('editor-conflict-banner').waitFor()
    assert.equal(await textarea.inputValue(), 'dirty-draft\n')
    await page.getByTestId('editor-save-btn').click()
    await page.getByTestId('editor-conflict-banner').waitFor()
    assert.equal(await readFile(join(ws, 'created.txt'), 'utf8'), 'external-dirty\n')
    assert.equal(await page.getByTestId('editor-delete-btn').count(), 0)

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
    await page.waitForFunction(() =>
      document.querySelector<HTMLTextAreaElement>('[data-testid="workspace-editor-textarea"]')?.readOnly,
    )
    assert.equal(await textarea.inputValue(), 'dirty-draft\n')
    await assert.rejects(stat(join(ws, 'blocked.txt')), { code: 'ENOENT' })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})
