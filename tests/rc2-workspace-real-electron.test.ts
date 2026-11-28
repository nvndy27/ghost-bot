import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'

async function waitForFileContent(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5000
  let actual = ''
  while (Date.now() < deadline) {
    actual = await readFile(path, 'utf8')
    if (actual === expected) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(actual, expected, `Timed out waiting for ${path} to contain the saved editor content`)
}

test('RC2.2 Electron: recover legacy root, authorize, edit, save, protect conflicts and switch workspaces', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-rc2-workspace-'))
  const firstWorkspace = join(dataDir, 'project-one')
  const secondWorkspace = join(dataDir, 'project-two')
  const firstFile = join(firstWorkspace, 'readme.txt')
  await mkdir(firstWorkspace)
  await mkdir(secondWorkspace)
  await writeFile(firstFile, 'Initial project one\n')
  await writeFile(join(secondWorkspace, 'second.txt'), 'Project two\n')

  const app = await launchWorkspaceElectron(dataDir)
  try {
    const page = await app.firstWindow()
    await page.getByTestId('workspace-panel-shell').waitFor()
    const botId = await page.evaluate(async () => {
      const bridge = window.ghostBot!
      const { bots } = await bridge.listBots()
      const bot = bots[0]
      await bridge.updateBot({
        id: bot.id,
        // The first-run seed already has a legacy literal tilde path. Only change permission here.
        patch: { permission: 'workspace' },
      })
      await bridge.setActiveBot(bot.id)
      return bot.id
    })

    await page.getByTestId('workspace-tab-files').click()
    await page.getByTestId('workspace-files-unavailable').waitFor()
    const recoverFolder = page.getByTestId('workspace-open-folder-unavailable-btn')
    await recoverFolder.waitFor()
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, firstWorkspace)
    await recoverFolder.click()
    await page.getByText('Allow read access to this bot workspace', { exact: false }).waitFor()

    const authorizeRead = page.getByRole('button', { name: 'Allow read access', exact: true })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_window, options) => {
        ;(globalThis as Record<string, unknown>).__rc2ReadConsentMessage = options.message
        return { response: 1 }
      }
    })
    await authorizeRead.click()
    await page.getByTestId('workspace-files-unavailable').waitFor()
    const consentMessage = await app.evaluate(() =>
      (globalThis as Record<string, unknown>).__rc2ReadConsentMessage,
    )
    assert.match(String(consentMessage), /project-one/)

    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0 })
    })
    await authorizeRead.click()
    await page.getByTestId('workspace-tree-entry-readme.txt').waitFor()
    await page.getByTestId('workspace-tree-entry-readme.txt').click()
    const editor = page.getByTestId('workspace-editor-textarea')
    await editor.waitFor()
    assert.equal(await editor.inputValue(), 'Initial project one\n')
    assert.equal(await page.getByTestId('workspace-files-permission-badge').innerText(), 'Read-only')

    await page.getByTestId('workspace-authorize-write-btn').click()
    await page.getByTestId('workspace-files-permission-badge').getByText('Writable').waitFor()
    await editor.fill('Saved using Ctrl+S\n')
    await editor.press('Control+s')
    await waitForFileContent(firstFile, 'Saved using Ctrl+S\n')

    await editor.fill('Uncommitted editor draft\n')
    await writeFile(firstFile, 'Changed by an external process\n')
    await page.getByTestId('editor-conflict-banner').waitFor()
    await page.getByTestId('editor-save-btn').click()
    await page.getByTestId('editor-conflict-banner').waitFor()
    assert.equal(await readFile(firstFile, 'utf8'), 'Changed by an external process\n')

    await page.getByTestId('editor-conflict-reload-btn').click()
    assert.equal(await editor.inputValue(), 'Changed by an external process\n')
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, secondWorkspace)
    await page.getByTestId('workspace-open-folder-btn').click()
    await page.getByText('Allow read access to this bot workspace', { exact: false }).waitFor()
    await page.getByTestId('workspace-files-unavailable').waitFor()
    await page.getByTestId('workspace-open-folder-unavailable-btn').waitFor()
    const switched = await page.evaluate(async (id) => {
      const context = await window.ghostBot!.resolveWorkspaceContext({ botId: id })
      return { root: context.canonicalRoot, authorized: context.authorized }
    }, botId)
    assert.equal(switched.root, secondWorkspace)
    assert.equal(switched.authorized, false, 'Switching folders must revoke the previous read grant')

    await page.getByRole('button', { name: 'Allow read access', exact: true }).click()
    await page.getByTestId('workspace-tree-entry-second.txt').waitFor()
    assert.equal(await page.getByTestId('workspace-tree-entry-readme.txt').count(), 0)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
