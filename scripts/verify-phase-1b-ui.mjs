import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = process.cwd()
const outDir = join(repoRoot, 'design', 'reviews', 'phase-1b')
await mkdir(outDir, { recursive: true })

const preview = spawn(
  process.execPath,
  [
    join(repoRoot, 'apps', 'desktop', 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4173',
    '--strictPort',
  ],
  { cwd: join(repoRoot, 'apps', 'desktop'), stdio: ['ignore', 'pipe', 'pipe'] },
)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview startup timeout')), 10_000)
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('4173')) {
      clearTimeout(timer)
      resolve()
    }
  })
  preview.once('exit', (code) => {
    clearTimeout(timer)
    reject(new Error(`vite preview exited early: ${code}`))
  })
})

const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome'
const browser = await chromium.launch({
  executablePath,
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

  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Chief of Staff')

  // 1. Dark workspace 1440x900
  await page.screenshot({ path: join(outDir, 'workspace-dark-1440x900.png') })

  // 2. Approval & Diff preview
  await page.getByRole('button', { name: 'Review diff' }).click()
  await page.waitForSelector('text=ROADMAP.md (simulated preview)')
  await page.screenshot({ path: join(outDir, 'approval-and-diff.png') })
  await page.getByRole('button', { name: 'Close diff preview' }).click()

  // 3. Settings Appearance + 12 avatars + 7 states
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.waitForSelector('text=Ghost Avatar Presets (12)')
  const presetCount = await page.locator('[aria-label$=" preset"]').count()
  assert.equal(presetCount, 12, 'Expected 12 avatar presets')
  const stateCount = await page.locator('[aria-label$=" state"]').count()
  assert.equal(stateCount, 7, 'Expected 7 avatar states')
  await page.screenshot({ path: join(outDir, 'settings-appearance.png') })

  // Scroll down in settings content to capture avatar states cleanly
  await page.locator('.gb-settings-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await page.screenshot({ path: join(outDir, 'avatar-states.png') })

  // Switch to Light theme
  await page.getByLabel('Theme').selectOption('light')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.screenshot({ path: join(outDir, 'workspace-light-1440x900.png') })

  // Switch back to Dark theme for collapsed screenshot
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.getByLabel('Theme').selectOption('dark')
  await page.getByRole('button', { name: 'Close settings' }).click()

  // 4. Bot search & selection
  await page.getByLabel('Search bots').fill('Researcher')
  assert.equal(await page.locator('[role="option"]').count(), 1)
  await page.getByRole('option', { name: /Researcher/ }).click()
  await page.getByLabel('Search bots').fill('')
  assert.equal(await page.locator('.gb-chat-header-title').innerText(), 'Researcher')

  // 5. Composer keyboard behavior & Full Access disabled
  const fullAccessDisabled = await page
    .locator('select[aria-label="Permission mode"] option[value="full-access"]')
    .isDisabled()
  assert.equal(fullAccessDisabled, true, 'Full Access must remain disabled')

  const composer = page.getByLabel('Message Researcher')
  await composer.fill('Line 1')
  await composer.press('Shift+Enter')
  await composer.type('Line 2')
  assert.ok((await composer.inputValue()).includes('\n'))
  await composer.press('Enter')
  await page.waitForSelector('text=Simulated mock reply')

  // 6. Resize & Collapse sidebars
  const leftSep = page.getByRole('separator', { name: 'Resize left sidebar' })
  await leftSep.focus()
  await leftSep.press('ArrowRight')
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await page.getByRole('button', { name: 'Collapse workspace panel' }).click()
  await page.screenshot({ path: join(outDir, 'sidebars-collapsed.png') })

  // 7. Minimum window size check (no horizontal overflow)
  await page.setViewportSize({ width: 960, height: 640 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  )
  assert.equal(overflow, false, 'Expected no horizontal overflow at 960x640')

  assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`)
  console.log(JSON.stringify({ uiVerification: 'passed', screenshots: 6, consoleErrors: 0 }))
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
