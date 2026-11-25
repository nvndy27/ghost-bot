import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = process.cwd()
const outDir = join(repoRoot, 'design', 'reviews', 'phase-1c')
await mkdir(outDir, { recursive: true })

const preview = spawn(
  process.execPath,
  [
    join(repoRoot, 'apps', 'desktop', 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4174',
    '--strictPort',
  ],
  { cwd: join(repoRoot, 'apps', 'desktop'), stdio: ['ignore', 'pipe', 'pipe'] },
)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview startup timeout')), 10_000)
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('4174')) {
      clearTimeout(timer)
      resolve()
    }
  })
  preview.once('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`vite preview exited early: ${code}`))
  })
})

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox'],
})

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(err.message))

  await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Chief of Staff')

  // 1. Open Create Bot + Avatar Editor + 7 states
  await page.getByRole('button', { name: 'Create bot' }).click()
  await page.waitForSelector('text=State preview:')
  await page.getByLabel('Shape Security').click()
  await page.getByRole('button', { name: 'thinking', exact: true }).click()
  await page.screenshot({ path: join(outDir, 'bot-editor-create.png') })

  // 2. Test malicious SVG rejection in UI
  const fileInput = page.getByLabel('Import custom SVG avatar')
  await fileInput.setInputFiles({
    name: 'evil.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg><script>alert(1)</script></svg>', 'utf8'),
  })
  await page.waitForSelector('[role="alert"]')
  await page.screenshot({ path: join(outDir, 'bot-editor-custom-svg-rejected.png') })

  // 3. Test safe SVG import
  await fileInput.setInputFiles({
    name: 'safe.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><circle cx="40" cy="40" r="32" fill="#418D79"/></svg>',
      'utf8',
    ),
  })
  await page.waitForSelector('text=Custom SVG renders as a static sandboxed image')
  await page.getByPlaceholder('e.g. Security Auditor').fill('SVG Bot')
  await page.screenshot({ path: join(outDir, 'bot-editor-custom-svg-accepted.png') })
  await page.getByRole('button', { name: 'Create bot' }).last().click()
  await page.waitForSelector('header >> text=SVG Bot')

  // 4. Regression test for Phase 1B timer-overwrite defect: switch bots mid-stream
  const composer = page.getByLabel('Message SVG Bot')
  await composer.fill('Stream test message with several words to span multiple ticks')
  await composer.press('Enter')
  await page.getByRole('option', { name: /Developer/ }).click()
  assert.equal(await page.getByRole('button', { name: 'Stop generation' }).isVisible(), true)
  await page.getByRole('button', { name: 'Stop generation' }).click()

  // 5. Delete all bots to verify empty-state recovery
  for (let i = 0; i < 6; i += 1) {
    const editBtn = page.getByRole('button', { name: 'Edit bot' })
    if ((await editBtn.count()) === 0) break
    await editBtn.click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Confirm delete' }).click()
  }
  await page.waitForSelector('text=No bots yet')
  await page.screenshot({ path: join(outDir, 'workspace-empty-state.png') })
  await page.getByRole('button', { name: 'Create your first bot' }).click()
  await page.getByPlaceholder('e.g. Security Auditor').fill('Recovered Bot')
  await page.getByRole('button', { name: 'Create bot' }).last().click()
  await page.waitForSelector('header >> text=Recovered Bot')

  assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`)
  console.log(JSON.stringify({ phase1cUiVerification: 'passed', screenshots: 4, consoleErrors: 0 }))
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
