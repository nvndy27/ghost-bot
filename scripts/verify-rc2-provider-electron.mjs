import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const desktop = join(process.cwd(), 'apps/desktop')
const root = await mkdtemp(join(tmpdir(), 'ghost-rc2-electron-'))
const home = join(root, 'home')
const config = join(root, 'xdg-config')
const runtimeDir = join(root, 'runtime')
const firstRunData = join(root, 'first-run-data')
const mockProfileData = join(root, 'mock-profile-data')
const fixtureBin = join(root, 'fixture-bin')
const syntheticWorkspace = join(root, 'synthetic-project')
const screenshotDir = process.env.RC2_SCREENSHOT_DIR ?? join(tmpdir(), `ghost-rc2-screenshots-${Date.now()}`)
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(config, { recursive: true }),
  mkdir(runtimeDir, { recursive: true, mode: 0o700 }),
  mkdir(fixtureBin, { recursive: true }),
  mkdir(syntheticWorkspace, { recursive: true }),
  mkdir(screenshotDir, { recursive: true }),
])
await chmod(runtimeDir, 0o700)
const codexFixturePath = join(fixtureBin, 'codex')
await writeFile(codexFixturePath, `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.172.0\\n')
  process.exit(0)
}
if (process.argv[2] !== 'app-server') process.exit(2)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    let result
    switch (message.method) {
      case 'initialize': result = { userAgent: 'codex-fixture/0.172.0' }; break
      case 'account/read': result = { account: { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' }, requiresOpenaiAuth: false }; break
      case 'model/list': result = { data: [{ id: 'fixture-codex-model', displayName: 'Fixture Codex Model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }] }] }; break
      case 'account/rateLimits/read': result = { rateLimits: { primary: { usedPercent: null, windowDurationMins: 300 } } }; break
      case 'thread/start': result = { thread: { id: 'fixture-thread-new' } }; break
      case 'thread/resume': result = { thread: { id: message.params?.threadId ?? 'fixture-thread-resumed' } }; break
      default:
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Fixture method not implemented' } }) + '\\n')
        continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
`)
await chmod(codexFixturePath, 0o700)

const waylandDisplay = 'ghost-rc2-wayland'
const weston = spawn('weston', [
  '--backend=headless', '--renderer=pixman', `--socket=${waylandDisplay}`,
  '--idle-time=0', '--width=1440', '--height=1000', '--no-config',
], {
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtimeDir },
  stdio: ['ignore', 'ignore', 'pipe'],
  detached: true,
})
let westonStderr = ''
weston.stderr?.on('data', (chunk) => { westonStderr = (westonStderr + String(chunk)).slice(-4000) })

const allocatePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

const waitFor = async (predicate, message, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) { lastError = error }
    if (weston.exitCode !== null) throw new Error(`Weston exited (${weston.exitCode}): ${westonStderr}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const processGroupExists = (pid) => {
  if (!pid) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'EPERM') return true
    if (error?.code === 'ESRCH') return false
    throw error
  }
}
const stopOwnedGroup = async (child, exitPromise, timeoutMs = 2_000) => {
  const pid = child.pid
  if (!pid || !processGroupExists(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch (error) { if (error?.code !== 'ESRCH') throw error }
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid) && Date.now() < deadline) await sleep(50)
  if (processGroupExists(pid)) {
    try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error?.code !== 'ESRCH') throw error }
    const killDeadline = Date.now() + 2_000
    while (processGroupExists(pid) && Date.now() < killDeadline) await sleep(50)
  }
  if (processGroupExists(pid)) throw new Error(`Owned process group ${pid} did not terminate`)
  if (exitPromise) await Promise.race([exitPromise, sleep(100)])
}

const safeEnv = (runtimeMode, dataDir, codexFixture = false) => ({
  PATH: `${codexFixture ? `${fixtureBin}:` : ''}${process.env.PATH ?? '/usr/bin:/bin'}`,
  HOME: home,
  XDG_CONFIG_HOME: config,
  XDG_RUNTIME_DIR: runtimeDir,
  WAYLAND_DISPLAY: waylandDisplay,
  GHOST_BOT_DATA_DIR: dataDir,
  GHOST_BOT_RUNTIME_MODE: runtimeMode,
  GHOST_SECRET_STORE_MODE: 'unavailable',
})

const waitForJson = async (port, path, child, stderr) => waitFor(async () => {
  if (child.exitCode !== null) throw new Error(`Electron exited (${child.exitCode}): ${stderr()}`)
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  if (!response.ok) return null
  return response.json()
}, `Electron endpoint ${path} did not start`)

const launch = async (runtimeMode, dataDir, codexFixture = false) => {
  const inspectorPort = await allocatePort()
  const devtoolsPort = await allocatePort()
  const child = spawn(join(desktop, 'node_modules/.bin/electron'), [
    '--ozone-platform=wayland',
    `--inspect=${inspectorPort}`,
    `--remote-debugging-port=${devtoolsPort}`,
    join(desktop, 'dist-electron/main.js'),
  ], { cwd: desktop, env: safeEnv(runtimeMode, dataDir, codexFixture), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  let stdout = ''
  child.stdout?.on('data', (chunk) => { stdout = (stdout + String(chunk)).slice(-8000) })
  child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000) })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  let browser
  try {
    await waitForJson(inspectorPort, '/json/list', child, () => stderr)
    await waitForJson(devtoolsPort, '/json/version', child, () => stderr)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtoolsPort}`)
    const context = browser.contexts()[0]
    const page = await waitFor(async () => context.pages()[0] ?? null, 'Electron renderer page did not open')
  const evaluateMain = async (expression) => {
    const targets = await waitForJson(inspectorPort, '/json/list', child, () => stderr)
    const target = targets.find((item) => item.type === 'node' && item.webSocketDebuggerUrl)
    assert.ok(target?.webSocketDebuggerUrl, 'Electron main inspector target was not available')
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const id = Math.floor(Math.random() * 1_000_000_000) + 1
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Electron main inspector request timed out')), 5_000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data))
        if (message.id !== id) return
        clearTimeout(timer)
        if (message.error) reject(new Error(message.error.message))
        else if (message.result?.exceptionDetails) {
          reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
        } else resolve(message.result?.result?.value)
      })
    })
    socket.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
    const value = await response
    socket.close()
    return value
  }
    const close = async () => {
      if (child.exitCode === null) {
        await evaluateMain("require('electron').app.quit(); 'quit-requested'").catch(() => undefined)
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
      }
      await stopOwnedGroup(child, exited)
      await browser.close().catch(() => undefined)
    }
    return { child, browser, page, evaluateMain, close, logs: () => ({ stdout, stderr }) }
  } catch (error) {
    await stopOwnedGroup(child, exited)
    await browser?.close().catch(() => undefined)
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`)
  }
}

const capture = async (page, name) => page.screenshot({ path: join(screenshotDir, `${name}.png`) })
const collectWindowErrors = (page) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('requestfailed', (request) => errors.push(`request failed: ${request.url()} ${request.failure()?.errorText ?? ''}`))
  return errors
}

let app
let acceptanceError
try {
  await waitFor(
    () => access(join(runtimeDir, waylandDisplay)).then(() => true).catch(() => false),
    'Weston Wayland socket did not start',
  )

  // A brand-new production profile must not receive silent mock bot seeds.
  app = await launch('codex', firstRunData)
  let page = app.page
  page.setDefaultTimeout(20_000)
  let errors = collectWindowErrors(page)
  await page.waitForTimeout(2_000)
  await capture(page, 'rc2-first-run-initial')
  try { await page.getByText('No bots yet', { exact: true }).waitFor({ timeout: 5_000 }) } catch (error) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined)
    await page.waitForTimeout(500)
    const state = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      body: document.body.innerText,
      scripts: [...document.scripts].map((script) => ({ src: script.src, type: script.type, readyState: script.readyState })),
      hasBridge: typeof window.ghostBot,
      rootExists: Boolean(document.getElementById('root')),
      root: document.querySelector('#root')?.innerHTML.slice(0, 2000),
      resources: performance.getEntriesByType('resource').map((entry) => entry.name).slice(-20),
    }))
    await capture(page, 'rc2-first-run-render-failure')
    throw new Error(`First-run screen failed to render expected setup state; screenshot=${join(screenshotDir, 'rc2-first-run-render-failure.png')} state=${JSON.stringify(state)} rendererErrors=${JSON.stringify(errors)} logs=${JSON.stringify(app.logs()).slice(-1800)}; ${error.message}`)
  }
  const freshBots = await page.evaluate(() => window.ghostBot.listBots())
  assert.equal(freshBots.bots.length, 0)
  await page.getByRole('button', { name: 'Create your first bot' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Create bot' })
  await createDialog.waitFor()
  const productionProviderOptions = await createDialog.getByLabel('Bot provider').locator('option').allTextContents()
  assert.ok(!productionProviderOptions.some((label) => /mock offline/i.test(label)))
  await capture(page, 'rc2-first-run-create-bot')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Configure providers' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).waitFor()
  await page.getByRole('button', { name: 'Accounts & Providers', exact: true }).waitFor()
  const freshCapabilities = await page.evaluate(() => window.ghostBot.getRuntimeProviderCapabilities())
  assert.equal(freshCapabilities.runtimeMode, 'codex')
  assert.deepEqual(freshCapabilities.providers.find((provider) => provider.id === 'mock-offline')?.models, [])
  assert.equal(freshCapabilities.providers.some((provider) => provider.models.some((model) => /mock/i.test(model.id))), false)
  await capture(page, 'rc2-first-run-providers')
  assert.deepEqual(errors, [])
  await app.close()
  app = undefined

  // Create an explicit offline demo profile, then reopen it in production mode.
  app = await launch('mock', mockProfileData)
  page = app.page
  page.setDefaultTimeout(20_000)
  errors = collectWindowErrors(page)
  await page.locator('[data-bot-id="chief"]').waitFor()
  const seededBots = await page.evaluate(() => window.ghostBot.listBots())
  assert.equal(seededBots.bots.length, 5)
  assert.ok(seededBots.bots.every((bot) => bot.runtimeId === 'mock-offline' && bot.modelId === 'mock-model'))
  const workspaceConfigured = await page.evaluate((workspacePath) => window.ghostBot.updateBot({
    id: 'chief', patch: { workspacePath },
  }), syntheticWorkspace)
  assert.equal(workspaceConfigured.workspacePath, syntheticWorkspace)
  await app.close()

  app = await launch('codex', mockProfileData)
  page = app.page
  page.setDefaultTimeout(20_000)
  errors = collectWindowErrors(page)
  await page.locator('[data-bot-id="chief"]').waitFor()
  const restored = await page.evaluate(async () => {
    const bots = await window.ghostBot.listBots()
    const readiness = await window.ghostBot.getRuntimeProviderCapabilities({ botId: 'chief' })
    return { bots, readiness }
  })
  assert.equal(restored.bots.bots.length, 5)
  assert.ok(restored.bots.bots.some((bot) => bot.id === 'chief' && bot.name === 'Chief of Staff' && bot.avatar.shape === 'chief'))
  assert.equal(restored.readiness.selectedBot?.ready, false)
  assert.equal(restored.readiness.selectedBot?.status, 'execution-gated')
  assert.equal(restored.readiness.selectedBot?.runtimeId, 'mock-offline')
  assert.ok(restored.readiness.providers.find((provider) => provider.id === 'codex')?.authentication !== 'connected')
  await page.getByRole('button', { name: 'Edit bot', exact: true }).click()
  await page.getByText(/This bot is configured for Offline Mock\./).waitFor()
  const editor = page.getByRole('dialog', { name: 'Edit bot' })
  await editor.waitFor()
  const recoveryOptions = await editor.getByLabel('Bot provider').locator('option').allTextContents()
  assert.ok(recoveryOptions.some((label) => /Mock Offline \(existing bot\)/i.test(label)))
  const recoveryModels = await editor.getByLabel('Bot model').locator('option').allTextContents()
  assert.ok(!recoveryModels.some((label) => /gpt-.*mock|mock model/i.test(label)))
  assert.equal(await editor.getByLabel('Bot model').isDisabled(), true)
  await capture(page, 'rc2-existing-mock-profile-recovery')
  await page.keyboard.press('Escape')

  const preservedAfterRecoveryInspection = await page.evaluate(async () => {
    const bots = await window.ghostBot.listBots()
    return bots.bots.find((bot) => bot.id === 'chief')
  })
  assert.equal(preservedAfterRecoveryInspection.runtimeId, 'mock-offline')
  assert.equal(preservedAfterRecoveryInspection.modelId, 'mock-model')
  assert.deepEqual(preservedAfterRecoveryInspection.avatar, restored.bots.bots.find((bot) => bot.id === 'chief').avatar)

  const uiStatus = await page.evaluate(() => ({
    header: document.querySelector('.gb-chat-header')?.innerText ?? '',
    sidebar: document.querySelector('[data-bot-id="chief"]')?.innerText ?? '',
    contextIsolation: typeof window.ghostBot === 'object',
    nodeRequire: typeof require !== 'undefined',
    rendererUrl: window.location.href,
  }))
  const sendDisabled = await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Send message"]') ?? document.querySelector('button[title="Send message"]')
    return button instanceof HTMLButtonElement ? button.disabled : null
  })
  assert.match(uiStatus.header, /Execution gated/)
  assert.match(uiStatus.sidebar, /\nMock\nExecution gated/)
  assert.doesNotMatch(uiStatus.header, /Codex Ready/)
  assert.equal(sendDisabled, true)
  assert.equal(uiStatus.contextIsolation, true)
  assert.equal(uiStatus.nodeRequire, false)
  assert.ok(uiStatus.rendererUrl.startsWith('file:'))
  const webPreferences = JSON.parse(await app.evaluateMain(`(() => {
    const loader = process.getBuiltinModule('module')
    const loadFromMain = loader.createRequire(process.cwd() + '/dist-electron/main.js')
    const windows = loadFromMain('electron').BrowserWindow.getAllWindows()
    const contents = windows[0]?.webContents
    const method = contents?.getLastWebPreferences
    const preferences = typeof method === 'function' ? method.call(contents) : null
    return JSON.stringify({ windowCount: windows.length, method: typeof method, preferences })
  })()`))
  assert.ok(webPreferences.windowCount > 0)
  assert.equal(webPreferences.method, 'function')
  assert.equal(webPreferences.preferences.sandbox, true)
  assert.equal(webPreferences.preferences.contextIsolation, true)
  assert.equal(webPreferences.preferences.nodeIntegration, false)
  await capture(page, 'rc2-existing-mock-profile-chat')
  assert.deepEqual(errors, [])

  await app.close()
  app = undefined
  // This disposable executable implements only Codex metadata and session-start
  // protocol responses. It cannot perform inference or contact a provider.
  app = await launch('codex', mockProfileData, true)
  page = app.page
  page.setDefaultTimeout(20_000)
  errors = collectWindowErrors(page)
  await page.locator('[data-bot-id="chief"]').waitFor()
  const fixtureCatalog = await page.evaluate(() => window.ghostBot.getRuntimeProviderCapabilities({ botId: 'chief' }))
  const fixtureCodex = fixtureCatalog.providers.find((provider) => provider.id === 'codex')
  assert.equal(fixtureCodex.authentication, 'connected')
  assert.equal(fixtureCodex.catalogState, 'available')
  assert.deepEqual(fixtureCodex.models.map((model) => model.id), ['fixture-codex-model'])
  assert.deepEqual(fixtureCodex.models[0].efforts, ['low', 'high', 'xhigh', 'max'])
  await page.getByRole('button', { name: 'Edit bot', exact: true }).click()
  const fixtureEditor = page.getByRole('dialog', { name: 'Edit bot' })
  await fixtureEditor.waitFor()
  await fixtureEditor.getByLabel('Bot provider').selectOption('codex')
  await fixtureEditor.getByLabel('Bot model').selectOption('fixture-codex-model')
  await fixtureEditor.getByLabel('Reasoning effort').selectOption('max')
  await fixtureEditor.getByLabel('Permission').selectOption('read-only')
  await fixtureEditor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await fixtureEditor.waitFor({ state: 'hidden' })
  const configuredFixtureBot = await page.evaluate(async () => {
    const bots = await window.ghostBot.listBots()
    const sessions = await window.ghostBot.listSessions({ agentId: 'chief' })
    return { bot: bots.bots.find((candidate) => candidate.id === 'chief'), sessions }
  })
  assert.equal(configuredFixtureBot.bot.runtimeId, 'codex')
  assert.equal(configuredFixtureBot.bot.modelId, 'fixture-codex-model')
  assert.equal(configuredFixtureBot.bot.effort, 'max')
  assert.equal(configuredFixtureBot.bot.permission, 'read-only')
  assert.ok(configuredFixtureBot.sessions.sessions.length >= 1)
  assert.ok(configuredFixtureBot.sessions.activeSessionId)
  assert.equal(configuredFixtureBot.bot.name, 'Chief of Staff')
  assert.deepEqual(configuredFixtureBot.bot.avatar, restored.bots.bots.find((bot) => bot.id === 'chief').avatar)
  await capture(page, 'rc2-controlled-codex-catalog-configured')
  await app.close()
  app = undefined

  app = await launch('codex', mockProfileData, true)
  page = app.page
  page.setDefaultTimeout(20_000)
  errors = collectWindowErrors(page)
  await page.locator('[data-bot-id="chief"]').waitFor()
  const afterRestart = await page.evaluate(async () => {
    const bots = await window.ghostBot.listBots()
    const sessions = await window.ghostBot.listSessions({ agentId: 'chief' })
    const readiness = await window.ghostBot.getRuntimeProviderCapabilities({ botId: 'chief' })
    return { bot: bots.bots.find((candidate) => candidate.id === 'chief'), sessions, readiness }
  })
  assert.equal(afterRestart.bot.runtimeId, 'codex')
  assert.equal(afterRestart.bot.modelId, 'fixture-codex-model')
  assert.equal(afterRestart.bot.effort, 'max')
  assert.equal(afterRestart.bot.permission, 'read-only')
  assert.equal(afterRestart.sessions.activeSessionId, configuredFixtureBot.sessions.activeSessionId)
  assert.equal(afterRestart.readiness.selectedBot?.runtimeId, 'codex')
  await capture(page, 'rc2-controlled-codex-restart')
  assert.deepEqual(errors, [])
  console.log(`RC2.1 actual Electron acceptance passed with Chromium sandbox enabled; screenshots: ${screenshotDir}`)
} catch (error) {
  acceptanceError = error
} finally {
  const cleanupErrors = []
  try { await app?.close() } catch (error) { cleanupErrors.push(error) }
  try {
    await stopOwnedGroup(weston, new Promise((resolve) => {
      if (weston.exitCode !== null) resolve()
      else weston.once('exit', resolve)
    }))
  } catch (error) { cleanupErrors.push(error) }
  try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }) } catch (error) { cleanupErrors.push(error) }
  if (acceptanceError && cleanupErrors.length) {
    acceptanceError = new Error(`${acceptanceError instanceof Error ? acceptanceError.stack : String(acceptanceError)}\nCleanup errors: ${cleanupErrors.map(String).join('; ')}`)
  } else if (!acceptanceError && cleanupErrors.length) {
    acceptanceError = new Error(`Electron acceptance cleanup failed: ${cleanupErrors.map(String).join('; ')}`)
  }
}
if (acceptanceError) throw acceptanceError
