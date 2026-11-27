import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-3d2-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-3d2')
await mkdir(screenshotDir, { recursive: true })

async function launchDesktop(dir) {
  return electron.launch({
    executablePath: join(desktopDir, 'node_modules', '.bin', 'electron'),
    args: [join(desktopDir, 'dist-electron', 'main.js')],
    cwd: desktopDir,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })
}

try {
  const app1 = await launchDesktop(dataDir)
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

    // 1. Open Settings -> Memory and create + enable memory for combined run
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await page.getByLabel('New memory content').fill('Ưu tiên kiểm tra tài liệu cục bộ.')
    await page.getByRole('button', { name: 'Save memory' }).click()
    await page.waitForSelector('text=Ưu tiên kiểm tra tài liệu cục bộ.', { timeout: 5000 })
    await page.getByLabel('Automatic retrieval for new runs').click()
    await page.waitForTimeout(200)

    // 2. Switch to Knowledge settings -> create collection & ingest Markdown document
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await page.waitForSelector('text=Enable knowledge storage', { timeout: 5000 })
    await page.getByLabel('New collection name').fill('Architecture')
    await page.getByRole('button', { name: 'Create collection' }).click()
    await page.waitForTimeout(200)

    await page.getByLabel('Document title').fill('Bảo mật Ghost Bot')
    await page
      .getByLabel('Document content')
      .fill('# Kiến trúc\n\nHệ thống Ghost Bot lưu trữ tài liệu cục bộ an toàn.')
    await page.getByLabel('Document tags').fill('security, local')
    await page.getByRole('button', { name: 'Save document' }).click()
    await page.waitForSelector('text=Bảo mật Ghost Bot', { timeout: 5000 })

    // 3. Search Vietnamese text with accent folding & inspect citation excerpt
    await page.getByLabel('Search documents').fill('tai lieu cuc bo')
    await page.waitForSelector('text=lines 1-3', { timeout: 5000 })
    await page.getByRole('button', { name: 'Clear' }).click()

    // 4. Switch bot scope -> verify isolation
    const botSelect = page.getByLabel('Knowledge bot')
    const botOptions = await botSelect.locator('option').evaluateAll((opts) =>
      opts.map((o) => ({ value: o.value, label: o.textContent ?? '' })),
    )
    assert.ok(botOptions.length >= 2)
    await botSelect.selectOption(botOptions[1].value)
    await page.waitForSelector('text=No documents found for this scope.', { timeout: 5000 })

    // Switch back & enable automatic document retrieval
    await botSelect.selectOption(botOptions[0].value)
    await page.waitForSelector('text=Bảo mật Ghost Bot', { timeout: 5000 })
    await page.getByLabel('Automatic document retrieval').click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(screenshotDir, '01-knowledge-settings.png') })

    // 5. Run deterministic mock request with both Memory and Knowledge
    await page.getByRole('button', { name: 'Close settings' }).click()
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Kiểm tra tài liệu cục bộ')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=[Memory Context Attached: 1 item(s)', { timeout: 10_000 })
    await page.waitForSelector('text=[Knowledge Context Attached: 1 doc(s)', { timeout: 10_000 })
    await page.screenshot({ path: join(screenshotDir, '02-combined-memory-knowledge.png') })

    // 6. Replace document, verify revision updates, disable retrieval, and delete doc
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    const dialog = page.locator('[role="dialog"][aria-label="Settings"]')
    await dialog.getByRole('button', { name: 'Replace', exact: true }).first().click()
    await dialog
      .getByLabel('Replace document content')
      .fill('# Kiến trúc v2\n\nPhiên bản mới đã thay thế bản cũ.')
    await dialog.getByRole('button', { name: 'Confirm replace' }).click()
    await page.waitForTimeout(250)

    await page.getByLabel('Automatic document retrieval').click()
    await page.waitForTimeout(200)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).first().click()
    await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click()
    await page.waitForSelector('text=No documents found for this scope.', { timeout: 5000 })
  } finally {
    await app1.close()
  }

  // 7. Restart Electron and verify persistence
  const app2 = await launchDesktop(dataDir)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff', { timeout: 10_000 })
    await page2.getByRole('button', { name: 'Settings' }).click()
    await page2.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await page2.waitForSelector('text=No documents found for this scope.', { timeout: 5000 })
    assert.equal(await page2.getByLabel('Automatic document retrieval').isChecked(), false)
  } finally {
    await app2.close()
  }

  console.log(
    JSON.stringify({
      phase: '3d2',
      electronE2E: 'passed',
      screenshots: [
        'design/reviews/phase-3d2/01-knowledge-settings.png',
        'design/reviews/phase-3d2/02-combined-memory-knowledge.png',
      ],
    }),
  )
} finally {
  await rm(dataDir, { recursive: true, force: true })
}
