import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const repoRoot = process.cwd()
const desktopDir = join(repoRoot, 'apps', 'desktop')
const fixtureServerPath = resolve(repoRoot, 'tests', 'fixtures', 'mcp-test-server.mjs')
const dataDir = await mkdtemp(join(tmpdir(), 'ghost-bot-3d3-e2e-'))
const screenshotDir = join(repoRoot, 'design', 'reviews', 'phase-3d3')
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
  let serverId = ''
  try {
    const page = await app1.firstWindow()
    await page.waitForSelector('text=Chief of Staff', { timeout: 10_000 })

    // 1. Open Settings -> Tools & MCP
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Tools & MCP', exact: true }).click()
    await page.waitForSelector('[data-testid="mcp-settings-section"]', { timeout: 5000 })

    // 2. Register local STDIO fixture server
    await page.getByTestId('mcp-name-input').fill('Local Fixture MCP')
    await page.getByTestId('mcp-exec-input').fill(process.execPath)
    await page.getByTestId('mcp-cwd-input').fill(dirname(fixtureServerPath))
    await page.getByTestId('mcp-args-input').fill(fixtureServerPath)
    await page.getByTestId('mcp-register-btn').click()

    const card = page.locator('[data-testid^="mcp-server-"]').first()
    await card.waitFor({ state: 'visible', timeout: 5000 })
    const testId = await card.getAttribute('data-testid')
    assert.ok(testId && testId.startsWith('mcp-server-'))
    serverId = testId.slice('mcp-server-'.length)

    assert.equal((await page.getByTestId(`mcp-trust-${serverId}`).textContent())?.trim(), 'untrusted')

    // 3. Approve trust -> Enable -> Connect & Discover
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
    await page.waitForSelector('text=echo_tool', { timeout: 5000 })

    // 4. Read resource & preview prompt
    await page.getByRole('button', { name: 'Read Fixture Info' }).click()
    await page.waitForSelector('text=fixture-resource-content-v1', { timeout: 5000 })
    await page.getByRole('button', { name: 'Preview greeting' }).click()
    await page.waitForSelector('text=Hello, world!', { timeout: 5000 })
    await page.screenshot({ path: join(screenshotDir, '01-mcp-settings-connected.png') })

    // 5. Close settings and run MCP tool call via composer
    await page.getByRole('button', { name: 'Close settings' }).click()
    const composer = page.getByLabel('Message Chief of Staff')
    await composer.fill(`mcp-tool:${serverId}/echo_tool {"text":"electron_e2e"}`)
    await page.getByRole('button', { name: 'Send message' }).click()

    // 6. Wait for approval prompt, screenshot, approve, and verify real STDIO tool output
    const approveBtn = page.getByRole('button', { name: /^Approve/ }).first()
    await approveBtn.waitFor({ state: 'visible', timeout: 8000 })
    await page.screenshot({ path: join(screenshotDir, '02-mcp-approval-pending.png') })
    await approveBtn.click()

    await page.waitForSelector('text=echo:electron_e2e', { timeout: 8000 })
    await page.screenshot({ path: join(screenshotDir, '03-mcp-tool-completed.png') })

    // 7. Reopen Settings -> Disconnect & Revoke Trust
    await page.getByRole('button', { name: 'Settings' }).click()
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

  // 8. Relaunch and verify SQLite persistence across restart
  const app2 = await launchDesktop(dataDir)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForSelector('text=Chief of Staff', { timeout: 10_000 })
    await page2.getByRole('button', { name: 'Settings' }).click()
    await page2.getByRole('button', { name: 'Tools & MCP', exact: true }).click()
    await page2.waitForSelector(`[data-testid="mcp-server-${serverId}"]`, { timeout: 5000 })
    assert.equal((await page2.getByTestId(`mcp-trust-${serverId}`).textContent())?.trim(), 'revoked')
    await page2.screenshot({ path: join(screenshotDir, '04-mcp-persisted-after-restart.png') })
  } finally {
    await app2.close()
  }

  console.log('Phase 3D.3 Electron MCP E2E PASS')
} finally {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
