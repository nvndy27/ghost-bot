import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'
import { openGhostBotDatabase } from '../apps/daemon/src/db/client.ts'
import { WorkspaceFilesService } from '../apps/daemon/src/workspace/files-service.ts'
import { WorkspaceGitService } from '../apps/daemon/src/workspace/git-service.ts'

function git(root: string, ...args: string[]) {
  return execFileSync('/usr/bin/git', args, {
    cwd: root,
    env: { PATH: '/usr/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function withRepo(fn: (root: string, outside: string) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), 'ghost-alpha2d1-'))
  try {
    const root = join(temporary, 'workspace')
    const outside = join(temporary, 'outside')
    await mkdir(root)
    await mkdir(outside)
    git(root, 'init', '-b', 'review-fixture')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(root, 'tracked.txt'), 'base line\n')
    await mkdir(join(root, 'secrets'))
    await writeFile(join(root, 'secrets', '.env'), 'hidden fixture\n')
    git(root, 'add', 'tracked.txt', 'secrets/.env')
    git(root, 'commit', '-m', 'Initial fixture')
    await fn(root, outside)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

test('read-only Git inspection keeps configuration inert and data inside the native grant', async (t) => {
  await withRepo(async (root, outside) => {
    const db = await openGhostBotDatabase(join(outside, 'db'))
    try {
      await writeFile(join(root, 'tracked.txt'), 'staged line\n')
      git(root, 'add', 'tracked.txt')
      await writeFile(join(root, 'tracked.txt'), 'unstaged line\n')
      await writeFile(join(root, 'untracked.txt'), 'new line\n')
      await writeFile(join(root, 'secrets', '.env'), 'another hidden fixture\n')
      const marker = join(outside, 'executed')
      await writeFile(join(outside, 'diff-program'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o700 })
      git(root, 'config', 'diff.external', join(outside, 'diff-program'))
      git(root, 'config', 'core.fsmonitor', join(outside, 'diff-program'))
      git(root, 'config', 'core.worktree', outside)
      await writeFile(join(root, '.git', 'objects', 'info', 'alternates'), join(outside, 'objects') + '\n')
      await writeFile(join(outside, 'private.txt'), 'outside fixture\n')
      await symlink(join(outside, 'private.txt'), join(root, 'linked.txt'))
      const indexBefore = await readFile(join(root, '.git', 'index'))

      const botId = 'git-review'
      const now = new Date().toISOString()
      db.sqlite.prepare(
        `INSERT INTO agents (id, name, description, instructions, avatar_json, runtime_id, model_id, effort,
          workspace_path, permission_mode, created_at, updated_at)
         VALUES (?, 'Git', '', '', '{}', 'mock', 'mock-model', 'medium', ?, 'read-only', ?, ?)`,
      ).run(botId, root, now, now)
      const files = new WorkspaceFilesService(db)
      const context = await files.resolveContext({ botId })
      assert.ok(context.workspaceId && context.authGeneration)
      const access = { botId, workspaceId: context.workspaceId, authGeneration: context.authGeneration }
      let grant = false
      const service = new WorkspaceGitService(files, () => { if (!grant) throw new Error('Native read grant required') })
      const operation = () => ({ ...access, operationId: randomUUID() })

      await assert.rejects(service.inspect({ ...operation(), kind: 'status' }), /Native read grant required/)
      grant = true
      const input = { ...operation(), kind: 'status' as const }
      const summary = await service.inspect(input)
      if (summary.result.kind === 'unavailable' && /isolated Git runtime/.test(summary.result.reason) &&
          process.env.GHOST_BOT_REQUIRE_GIT_SANDBOX !== '1') {
        t.skip(summary.result.reason)
        return
      }
      assert.equal(summary.result.kind, 'status', JSON.stringify(summary.result))
      assert.equal(summary.operationId, input.operationId)
      assert.equal(summary.result.branch, 'review-fixture')
      assert.deepEqual(summary.result.staged, [{ path: 'tracked.txt', code: 'M' }])
      assert.deepEqual(summary.result.unstaged, [{ path: 'tracked.txt', code: 'M' }])
      assert.deepEqual(summary.result.untracked, [{ path: 'untracked.txt', code: '?' }])
      const [first] = summary.result.history
      assert.equal(first.subject, 'Initial fixture')
      for (const [layer, path, pattern] of [
        ['staged', 'tracked.txt', /-base line\n\+staged line/],
        ['unstaged', 'tracked.txt', /-staged line\n\+unstaged line/],
        ['untracked', 'untracked.txt', /\+new line/],
      ] as const) {
        const { result } = await service.inspect({ ...operation(), kind: 'diff', relativePath: path, layer })
        assert.equal(result.kind, 'diff', JSON.stringify(result))
        assert.match(result.patch, pattern)
      }
      for (const relativePath of ['secrets', 'secrets/.env', '.git/config', '../outside/private.txt', 'linked.txt']) {
        await assert.rejects(service.inspect({ ...operation(), kind: 'diff', relativePath, layer: 'unstaged' }), {
          code: 'GIT_PATH_DENIED',
        })
      }
      await writeFile(join(root, 'large.txt'), 'long fixture line\n'.repeat(10_000))
      const bounded = await service.inspect({ ...operation(), kind: 'diff', relativePath: 'large.txt', layer: 'untracked' })
      assert.equal(bounded.result.kind, 'diff')
      assert.equal(bounded.result.truncated, true)
      assert.ok(Buffer.byteLength(bounded.result.patch) <= 128 * 1024)
      await rm(join(root, 'large.txt'))
      const details = await service.inspect({ ...operation(), kind: 'commit', commitId: first.id })
      assert.equal(details.result.kind, 'commit')
      assert.match(details.result.message, /Initial fixture/)
      assert.deepEqual(details.result.files, [{ path: 'tracked.txt', code: 'A' }])

      const cancelling = { ...operation(), kind: 'status' as const }
      const cancelled = assert.rejects(service.inspect(cancelling), { name: 'AbortError' })
      const cancelInput = { ...access, operationId: cancelling.operationId }
      assert.equal(await service.cancel({ ...cancelInput, authGeneration: 'different' }), false)
      assert.equal(await service.cancel(cancelInput), true)
      await cancelled
      await assert.rejects(readFile(marker), { code: 'ENOENT' })
      assert.deepEqual(await readFile(join(root, '.git', 'index')), indexBefore)
      await rename(join(root, '.git'), join(outside, 'external-git'))
      const absent = await service.inspect({ ...operation(), kind: 'status' })
      assert.deepEqual(absent.result, {
        kind: 'unavailable', reason: 'No Git repository at the authorized workspace root.',
      })
      await writeFile(join(root, '.git'), `gitdir: ${join(outside, 'external-git')}\n`)
      const redirected = await service.inspect({ ...operation(), kind: 'status' })
      assert.equal(redirected.result.kind, 'unavailable')
      assert.match(redirected.result.reason, /redirected metadata/)
      db.sqlite.prepare("UPDATE agents SET updated_at = '2030-01-01' WHERE id = ?").run(botId)
      await assert.rejects(service.inspect({ ...operation(), kind: 'status' }), { code: 'WORKSPACE_CONTEXT_MISMATCH' })
    } finally {
      db.close()
    }
  })
})

test('Electron Changes tab renders native-granted status, file diffs and commit details', async (t) => {
  await withRepo(async (root, outside) => {
    await writeFile(join(root, 'tracked.txt'), 'changed in Electron\n')
    await writeFile(join(root, 'new.txt'), 'new file\n')
    const dataDir = join(outside, 'electron-data')
    await mkdir(dataDir)
    const app = await launchWorkspaceElectron(dataDir)
    try {
      const page = await app.firstWindow()
      await page.getByTestId('workspace-tab-changes').waitFor()
      const botId = await page.evaluate(async (workspacePath) => {
        const bridge = window.ghostBot!
        const { activeBotId } = await bridge.listBots()
        if (!activeBotId) throw new Error('Missing mock fixture bot')
        await bridge.updateBot({ id: activeBotId, patch: { workspacePath, permission: 'read-only' } })
        return activeBotId
      }, root)
      await page.getByTestId('workspace-tab-changes').click()
      const panel = page.getByTestId('workspace-git-changes')
      const consent = panel.getByRole('button', { name: 'Allow read access' })
      await consent.waitFor()
      await assert.rejects(page.evaluate(async (id) => {
        const bridge = window.ghostBot!
        const context = await bridge.resolveWorkspaceContext({ botId: id })
        return bridge.inspectWorkspaceGit({
          botId: id, workspaceId: context.workspaceId!, authGeneration: 'invalid',
          operationId: crypto.randomUUID(), kind: 'status',
        })
      }, botId), /authorization changed|read access has not been granted/i)
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0 })
      })
      await consent.click()
      await panel.getByText(/review-fixture|isolated Git runtime/).waitFor()
      if (await panel.getByText(/isolated Git runtime/).count()) {
        assert.notEqual(process.env.GHOST_BOT_REQUIRE_GIT_SANDBOX, '1', 'Git sandbox required for this run')
        t.skip('Optional isolated Git runtime is unavailable')
        return
      }
      for (const name of ['Stage selected files', 'Unstage selected files', 'Revert file']) {
        assert.equal(await panel.getByRole('button', { name, exact: true }).isDisabled(), true)
      }
      await panel.getByText(/Git writes are unavailable/).waitFor()
      assert.equal(await page.evaluate(() =>
        Object.keys(window.ghostBot!).some((key) => /^(mutateWorkspaceGit|authorizeWorkspaceGitMutation)$/.test(key))), false)
      await panel.getByRole('button', { name: 'tracked.txt' }).click()
      const diff = panel.getByTestId('workspace-git-diff')
      await diff.waitFor()
      assert.match(await diff.innerText(), /-base line\s+\+changed in Electron/)
      await panel.getByRole('button', { name: 'new.txt' }).click()
      await diff.getByText('+new file', { exact: true }).waitFor()
      await panel.getByRole('button', { name: /Initial fixture/ }).click()
      const commit = panel.getByRole('region', { name: 'Commit details' })
      await commit.getByText('Fixture', { exact: false }).first().waitFor()
      assert.equal(await panel.getByRole('button', { name: /^(Stage|Commit|Push|Pull|Reset)$/ }).count(), 0)

      // The third-party Git change is made by the fixture. Refresh must display it without rewriting the index.
      git(root, 'add', 'new.txt')
      await writeFile(join(root, 'tracked.txt'), 'external refresh\n')
      const externalIndex = await readFile(join(root, '.git', 'index'))
      await panel.getByRole('button', { name: 'Refresh Git changes' }).click()
      await panel.getByRole('region', { name: 'Staged' }).getByRole('button', { name: 'new.txt' }).waitFor()
      assert.equal(await commit.count(), 0)
      await panel.getByRole('region', { name: 'Unstaged' }).getByRole('button', { name: 'tracked.txt' }).click()
      await diff.getByText('+external refresh', { exact: true }).waitFor()
      assert.deepEqual(await readFile(join(root, '.git', 'index')), externalIndex)
      assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new file\n')
      assert.equal(await readFile(join(root, 'secrets', '.env'), 'utf8'), 'hidden fixture\n')

      await page.evaluate((id) => window.ghostBot!.updateBot({ id, patch: { permission: 'read-only' } }), botId)
      await panel.getByRole('button', { name: 'Refresh Git changes' }).click()
      await consent.waitFor()
      assert.equal(await panel.getByRole('button', { name: 'Revert file' }).isDisabled(), true)
      assert.equal(await diff.count(), 0)
      assert.equal(await commit.count(), 0)
    } finally {
      await app.close()
    }
  })
})
