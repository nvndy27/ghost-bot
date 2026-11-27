import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const tempRoot = mkdtempSync(join(tmpdir(), 'ghost-p7-e2e-'))
chmodSync(tempRoot, 0o700)
const dataDir = join(tempRoot, 'data')
const workspaceDir = join(tempRoot, 'workspace')
mkdirSync(workspaceDir, { recursive: true })
chmodSync(workspaceDir, 0o700)

let serverMode = 'normal'
let activeStallRes = null

const lmServer = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'local-qwen-7b' }] }))
    return
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    for await (const _chunk of req) {
      // drain request body
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (serverMode === 'stall') {
      res.write('data: {"choices":[{"delta":{"content":"Streaming partial..."}}]}\n\n')
      activeStallRes = res
      req.on('close', () => {
        activeStallRes = null
      })
      return
    }
    res.write('data: {"choices":[{"delta":{"content":"Desktop Loopback "}}]}\n\n')
    res.write('data: {"choices":[{"delta":{"content":"LM Studio Reply"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404).end()
})

await new Promise((resolveListen) => lmServer.listen(0, '127.0.0.1', resolveListen))
const lmAddress = lmServer.address()
assert(lmAddress && typeof lmAddress !== 'string')
const lmBaseUrl = `http://127.0.0.1:${lmAddress.port}/v1`

const app = await electron.launch({
  args: [resolve('apps/desktop/dist-electron/main.js'), '--no-sandbox'],
  env: {
    ...process.env,
    GHOST_BOT_DATA_DIR: dataDir,
    GHOST_BOT_RUNTIME_MODE: 'mock',
    GHOST_SECRET_NAMESPACE: `p7-e2e-${randomUUID().slice(0, 8)}`,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')

  // 1. Configure LM Studio loopback endpoint in Settings
  await win.getByRole('button', { name: /Settings/i }).click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /Accounts & Providers/i }).click()
  await settings.getByTestId('lmstudio-status-card').waitFor({ timeout: 10_000 })
  await settings.getByTestId('lmstudio-url-input').fill(lmBaseUrl)
  await settings.getByTestId('lmstudio-save-url-btn').click()
  await settings.getByText('connected').first().waitFor({ timeout: 10_000 })
  await win.evaluate(
    (url) => window.ghostBot.setLmStudioConfig({ baseUrl: url, executionAuthorized: true }),
    lmBaseUrl,
  )
  await settings.getByRole('button', { name: /Close settings/i }).click()

  // 2. Create an unauthorized OpenRouter bot and verify fail-closed denial without Codex/mock fallback
  await win
    .getByRole('button', { name: /\+ New bot/i })
    .or(win.getByTitle(/New bot/i))
    .or(win.locator('button', { hasText: '+' }).first())
    .click()
  let botDialog = win.getByRole('dialog', { name: /Create bot/i })
  await botDialog.waitFor({ timeout: 10_000 })
  await botDialog
    .getByPlaceholder(/Name/i)
    .or(botDialog.locator('input[type="text"]').first())
    .fill('Unauth OpenRouter')
  await botDialog.getByTestId('bot-runtime-select').selectOption('openrouter')
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()
  await win.getByText('Unauth OpenRouter').first().waitFor({ timeout: 10_000 })

  const composer = win.getByPlaceholder(/Message/i).or(win.locator('textarea').first())
  await composer.fill('Should be denied')
  await composer.press('Enter')
  await win.getByRole('alert').or(win.getByText(/unauthorized|denied|credential/i)).first().waitFor({
    timeout: 10_000,
  })

  // 3. Create an LM Studio bot and verify full Desktop -> IPC -> Daemon -> Orchestrator -> Loopback HTTP streaming
  await win
    .getByRole('button', { name: /\+ New bot/i })
    .or(win.getByTitle(/New bot/i))
    .or(win.locator('button', { hasText: '+' }).first())
    .click()
  botDialog = win.getByRole('dialog', { name: /Create bot/i })
  await botDialog.waitFor({ timeout: 10_000 })
  await botDialog
    .getByPlaceholder(/Name/i)
    .or(botDialog.locator('input[type="text"]').first())
    .fill('LM Studio Live E2E')
  await botDialog.getByTestId('bot-runtime-select').selectOption('lmstudio')
  await botDialog.locator('input[type="text"]').last().fill(workspaceDir)
  await botDialog.getByRole('button', { name: /Create bot|Save/i }).click()
  await win.getByText('LM Studio Live E2E').first().waitFor({ timeout: 10_000 })

  await composer.fill('Hello from Electron E2E')
  await composer.press('Enter')
  await win.getByText('Desktop Loopback LM Studio Reply').waitFor({ timeout: 15_000 })

  // 4. Reload renderer and verify durable persistence
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
  await win.getByText('Desktop Loopback LM Studio Reply').waitFor({ timeout: 15_000 })

  // 5. Verify cancellation of stalled stream
  serverMode = 'stall'
  await composer.fill('Stall and cancel')
  await composer.press('Enter')
  await win.getByText('Streaming partial...').waitFor({ timeout: 10_000 })
  const stopBtn = win.getByRole('button', { name: /Stop|Cancel/i }).first()
  await stopBtn.click()
  await win.getByText(/\[Cancelled\]/i).waitFor({ timeout: 10_000 })
  if (activeStallRes) {
    activeStallRes.end()
    activeStallRes = null
  }

  console.log('PROVIDER7_UNIFIED_EXECUTION_DESKTOP_E2E_PASSED')
} finally {
  await app.close()
  await new Promise((resolveClose) => lmServer.close(() => resolveClose()))
  rmSync(tempRoot, { recursive: true, force: true })
}
