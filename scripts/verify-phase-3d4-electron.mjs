import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const fixtureServerPath = resolve(repoRoot, 'tests', 'fixtures', 'mcp-test-server.mjs')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-3d4-e2e-'))
const counterFile = join(dataDir, 'mcp-invocations.log')
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-3d4')
await mkdir(screenshotDir, { recursive: true })

async function readInvocationCount() {
  try {
    const raw = await readFile(counterFile, 'utf8')
    return raw.split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

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
  let serverId = ''
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

    // 1. Settings -> Memory: create, search, and enable automatic retrieval
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    await page.getByLabel('New memory content').fill('Ưu tiên kiểm tra tài liệu cục bộ 3D4.')
    await page.getByRole('button', { name: 'Save memory' }).click()
    await page.waitForSelector('text=Ưu tiên kiểm tra tài liệu cục bộ 3D4.', { timeout: 5000 })
    await page.getByLabel('Automatic retrieval for new runs').click()
    await page.waitForTimeout(150)

    // 2. Settings -> Knowledge: create collection, ingest Markdown, Vietnamese search & citation
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await page.waitForSelector('text=Enable knowledge storage', { timeout: 5000 })
    await page.getByLabel('New collection name').fill('Architecture-3D4')
    await page.getByRole('button', { name: 'Create collection' }).click()
    await page.waitForTimeout(150)

    await page.getByLabel('Document title').fill('Bảo mật Ghost Bot 3D4')
    await page
      .getByLabel('Document content')
      .fill('# Kiến trúc\n\nHệ thống Ghost Bot lưu trữ tài liệu cục bộ an toàn.')
    await page.getByLabel('Document tags').fill('security, local')
    await page.getByRole('button', { name: 'Save document' }).click()
    await page.waitForSelector('text=Bảo mật Ghost Bot 3D4', { timeout: 5000 })

    await page.getByLabel('Search documents').fill('tai lieu cuc bo')
    await page.waitForSelector('text=lines 1-3', { timeout: 5000 })
    await page.getByRole('button', { name: 'Clear' }).click()
    await page.getByLabel('Automatic document retrieval').click()
    await page.waitForTimeout(150)

    // 3. Settings -> Tools & MCP: register counted local STDIO server, trust, enable, connect, inspect
    await page.getByRole('button', { name: 'Tools & MCP', exact: true }).click()
    await page.waitForSelector('[data-testid="mcp-settings-section"]', { timeout: 5000 })

    await page.getByTestId('mcp-name-input').fill('Integrated Fixture MCP')
    await page.getByTestId('mcp-exec-input').fill(process.execPath)
    await page.getByTestId('mcp-cwd-input').fill(dirname(fixtureServerPath))
    await page.getByTestId('mcp-args-input').fill(`${fixtureServerPath}\n--counter\n${counterFile}`)
    await page.getByTestId('mcp-register-btn').click()

    const card = page.locator('[data-testid^="mcp-server-"]').first()
    await card.waitFor({ state: 'visible', timeout: 5000 })
    const testId = await card.getAttribute('data-testid')
    assert.ok(testId && testId.startsWith('mcp-server-'))
    serverId = testId.slice('mcp-server-'.length)

    assert.equal((await page.getByTestId(`mcp-trust-${serverId}`).textContent())?.trim(), 'untrusted')
    await page.getByTestId(`mcp-approve-trust-${serverId}`).click()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="mcp-trust-${id}"]`)?.textContent?.trim() === 'trusted',
      serverId,
      { timeout: 5000 },
    )
    await page.getByTestId(`mcp-toggle-enabled-${serverId}`).click()
    await page.waitForSelector(`[data-testid="mcp-connect-${serverId}"]`, { timeout: 5000 })
    await page.getByTestId(`mcp-connect-${serverId}`).click()
    await page.waitForSelector('[data-testid="mcp-capabilities-panel"]', { timeout: 5000 })
    await page.getByRole('button', { name: 'Read Fixture Info' }).click()
    await page.waitForSelector('text=fixture-resource-content-v1', { timeout: 5000 })
    await page.getByRole('button', { name: 'Preview greeting' }).click()
    await page.waitForSelector('text=Hello, world!', { timeout: 5000 })
    await page.screenshot({ path: join(screenshotDir, '01-integrated-settings.png') })

    // 4. Close settings -> run combined Memory + Knowledge mock prompt
    await page.getByRole('button', { name: 'Close settings' }).click()
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill('Kiểm tra tài liệu cục bộ')
    await page.getByRole('button', { name: 'Send message' }).click()
    await page.waitForSelector('text=[Memory Context Attached: 1 item(s)', { timeout: 10_000 })
    await page.waitForSelector('text=[Knowledge Context Attached: 1 doc(s)', { timeout: 10_000 })

    // 5. Propose first MCP tool -> Deny -> verify 0 fixture invocations
    await composer.fill(`mcp-tool:${serverId}/echo_tool {"text":"deny_first"}`)
    await page.getByRole('button', { name: 'Send message' }).click()
    const denyBtn = page.getByRole('button', { name: 'Deny' }).first()
    await denyBtn.waitFor({ state: 'visible', timeout: 8000 })
    await denyBtn.click()
    await page.waitForSelector('text=denied by user', { timeout: 8000 })
    assert.equal(await readInvocationCount(), 0)

    // 6. Propose second MCP tool -> Approve -> verify 1 fixture invocation
    await composer.fill(`mcp-tool:${serverId}/echo_tool {"text":"integrated_ok"}`)
    await page.getByRole('button', { name: 'Send message' }).click()
    const approveBtn = page.getByRole('button', { name: /^Approve/ }).first()
    await approveBtn.waitFor({ state: 'visible', timeout: 8000 })
    await page.screenshot({ path: join(screenshotDir, '02-mcp-approval-pending.png') })
    await approveBtn.click()
    await page.waitForSelector('text=echo:integrated_ok', { timeout: 8000 })
    assert.equal(await readInvocationCount(), 1)
    await page.screenshot({ path: join(screenshotDir, '03-integrated-conversation.png') })

    // 7. Open Settings -> switch Memory bot scope -> verify cross-scope isolation
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Memory', exact: true }).click()
    const memBotSelect = page.getByLabel('Memory bot')
    const memBotOptions = await memBotSelect.locator('option').evaluateAll((opts) =>
      opts.map((o) => ({ value: o.value })),
    )
    assert.ok(memBotOptions.length >= 2)
    await memBotSelect.selectOption(memBotOptions[1].value)
    await page.waitForSelector('text=No memories found for this scope.', { timeout: 5000 })
    await memBotSelect.selectOption(memBotOptions[0].value)

    // 8. Revoke Memory/Knowledge consent, delete Knowledge doc, & revoke MCP trust
    await page.getByLabel('Automatic retrieval for new runs').click()
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await page.getByLabel('Automatic document retrieval').click()
    await page.getByRole('button', { name: 'Tools & MCP', exact: true }).click()
    await page.getByTestId(`mcp-disconnect-${serverId}`).click()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="mcp-conn-${id}"]`)?.textContent?.trim() === 'disconnected',
      serverId,
      { timeout: 5000 },
    )
    await page.getByTestId(`mcp-revoke-trust-${serverId}`).click()
    await page.waitForFunction(
      (id) => document.querySelector(`[data-testid="mcp-trust-${id}"]`)?.textContent?.trim() === 'revoked',
      serverId,
      { timeout: 5000 },
    )
  } finally {
    await app1.close()
  }

  // 9. Relaunch and verify persisted state without auto-launching MCP server
  const app2 = await launchDesktop(dataDir)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff', { timeout: 10_000 })
    await page2.getByRole('button', { name: 'Settings' }).click()
    await page2.getByRole('button', { name: 'Tools & MCP', exact: true }).click()
    await page2.waitForSelector(`[data-testid="mcp-server-${serverId}"]`, { timeout: 5000 })
    assert.equal((await page2.getByTestId(`mcp-trust-${serverId}`).textContent())?.trim(), 'revoked')
    assert.equal((await page2.getByTestId(`mcp-conn-${serverId}`).textContent())?.trim(), 'disconnected')
    await page2.screenshot({ path: join(screenshotDir, '04-restarted-persisted.png') })
  } finally {
    await app2.close()
  }

  console.log(JSON.stringify({ phase: '3d4', electronE2E: 'passed', mcpInvocations: await readInvocationCount() }))
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
