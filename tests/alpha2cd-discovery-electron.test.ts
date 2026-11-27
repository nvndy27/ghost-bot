import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWorkspaceElectron } from './helpers/workspace-electron.ts'

function pdf() {
  const stream = '0 0 30 20 re f\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 200] /Contents 3 0 R >>',
  ]
  let source = '%PDF-1.4\n'
  const entries = ['0000000000 65535 f \n']
  objects.forEach((object, i) => {
    entries.push(`${String(source.length).padStart(10, '0')} 00000 n \n`)
    source += `${i + 1} 0 obj\n${object}\nendobj\n`
  })
  return source + `xref\n0 5\n${entries.join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${source.length}\n%%EOF\n`
}

test('combined Electron discovery uses real grant, search, preview, cancel and the originating draft', async () => {
  const data = await mkdtemp(join(tmpdir(), 'ghost-alpha2cd-'))
  const workspace = join(data, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'notes.md'), '# Review\nThis is the fixture needle.\n')
  await writeFile(join(workspace, 'page.pdf'), pdf())
  const app = await launchWorkspaceElectron(data)
  try {
    const page = await app.firstWindow()
    const botId = await page.evaluate(async (root) => {
      const bridge = window.ghostBot!
      const { activeBotId } = await bridge.listBots()
      if (!activeBotId) throw new Error('Missing fixture bot')
      await bridge.updateBot({ id: activeBotId, patch: { workspacePath: root, permission: 'read-only' } })
      return activeBotId
    }, workspace)
    await page.getByTestId('workspace-tab-files').click()
    await app.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] })
    }, workspace)
    await page.getByRole('button', { name: 'Allow read access' }).click()
    const search = page.getByRole('searchbox', { name: 'Search workspace' })
    await search.fill('notes')
    await search.press('Enter')
    await page.getByRole('listitem').getByRole('button', { name: 'notes.md', exact: true }).waitFor()
    await page.getByRole('combobox', { name: 'Search scope' }).selectOption('content')
    await search.fill('needle')
    await search.press('Enter')
    await page.getByRole('button', { name: /notes\.md:2.*fixture needle/ }).click()
    const editor = page.getByTestId('workspace-editor-textarea')
    await editor.waitFor()
    await page.waitForFunction(() => {
      const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="workspace-editor-textarea"]')
      return editor?.value.slice(editor.selectionStart, editor.selectionEnd) === 'This is the fixture needle.'
    })
    await editor.press('Control+a')
    const conversations = page.getByLabel('Conversation session')
    const origin = await conversations.inputValue()
    assert.ok(origin)
    const draft = page.getByRole('textbox', { name: /^Message / })
    await page.getByRole('button', { name: 'Add selection to chat draft' }).click()
    await page.waitForFunction(() => Array.from(document.querySelectorAll('textarea')).some(
      (field) => field.getAttribute('aria-label')?.startsWith('Message ') && field.value.includes('fixture needle'),
    ))
    assert.match(await draft.inputValue(), /fixture needle/)
    const dispatched = await page.evaluate((sessionId) => window.ghostBot!.listMessages({ sessionId }), origin)
    assert.equal(dispatched.messages.length, 0)

    await page.getByTestId('workspace-tree-entry-page.pdf').click()
    const preview = page.getByRole('region', { name: 'File preview' })
    await preview.getByRole('img', { name: 'page.pdf, page 1' }).waitFor()
    assert.equal(await preview.getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth > 0), true)

    const outcome = await page.evaluate(async (id) => {
      const bridge = window.ghostBot!
      const granted = await bridge.resolveWorkspaceContext({ botId: id })
      const input = { botId: id, workspaceId: granted.workspaceId!, authGeneration: granted.authGeneration!, operationId: crypto.randomUUID() }
      const pending = bridge.previewWorkspaceFile({ ...input, relativePath: 'page.pdf', page: 1 })
        .then(() => 'released', (error: unknown) => String(error))
      const cancelled = await bridge.cancelWorkspaceDiscovery(input)
      await bridge.updateBot({ id, patch: { permission: 'read-only' } })
      const stale = await bridge.searchWorkspaceFiles({ ...input, operationId: crypto.randomUUID(), mode: 'filename', query: 'notes' })
        .then(() => 'released', (error: unknown) => String(error))
      return { cancelled, pending: await pending, stale }
    }, botId)
    assert.equal(outcome.cancelled, true)
    assert.match(outcome.pending, /abort|cancel/i)
    assert.match(outcome.stale, /authorization changed|not been granted/i)
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})
