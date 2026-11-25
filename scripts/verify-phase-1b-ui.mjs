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

  // 2. Approval & Diff preview + Escape restoration
  const reviewDiffBtn = page.getByRole('button', { name: 'Review diff' })
  await reviewDiffBtn.focus()
  await reviewDiffBtn.click()
  await page.waitForSelector('text=ROADMAP.md (simulated preview)')
  await page.screenshot({ path: join(outDir, 'approval-and-diff.png') })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('text=ROADMAP.md (simulated preview)').count(), 0, 'Escape should close diff modal')
  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    'Review diff',
    'Focus should restore to Review diff trigger',
  )

  // 3. Settings Appearance + 12 avatars + 7 states + focus trap + Escape
  const settingsBtn = page.getByRole('button', { name: 'Open Settings' })
  await settingsBtn.focus()
  await settingsBtn.click()
  await page.waitForSelector('text=Ghost Avatar Presets (12)')
  const presetCount = await page.locator('[aria-label$=" preset"]').count()
  assert.equal(presetCount, 12, 'Expected 12 avatar presets')
  const stateCount = await page.locator('[aria-label$=" state"]').count()
  assert.equal(stateCount, 7, 'Expected 7 avatar states')
  await page.screenshot({ path: join(outDir, 'settings-appearance.png') })

  // Verify focus stays inside Settings dialog when pressing Shift+Tab from first focusable
  await page.keyboard.press('Shift+Tab')
  const insideSettings = await page.evaluate(
    () => Boolean(document.activeElement?.closest('[role="dialog"]')),
  )
  assert.equal(insideSettings, true, 'Focus trap must keep focus inside Settings dialog')

  // Scroll down in settings content to capture avatar states cleanly
  await page.locator('.gb-settings-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await page.screenshot({ path: join(outDir, 'avatar-states.png') })

  // Switch to Light theme and verify persistence across reload
  await page.getByLabel('Theme').selectOption('light')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('[role="dialog"]').count(), 0, 'Escape should close Settings')
  await page.screenshot({ path: join(outDir, 'workspace-light-1440x900.png') })

  await page.reload({ waitUntil: 'networkidle' })
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light', 'Theme preference should persist across reload')

  // Switch to System and then Dark theme for collapsed screenshot
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.getByLabel('Theme').selectOption('system')
  await page.getByLabel('Theme').selectOption('dark')
  await page.keyboard.press('Escape')

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
  // Whitespace-only message cannot be submitted
  await composer.fill('   ')
  assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true)

  // IME composition Enter must not send
  await composer.fill('Tiếng Việt')
  await composer.evaluate((el) => {
    const evt = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    Object.defineProperty(evt, 'isComposing', { value: true })
    el.dispatchEvent(evt)
  })
  assert.equal(await page.locator('text=Simulated mock reply').count(), 0, 'IME Enter must not send')

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

  // 7. Viewport matrix check (no horizontal overflow at 1920x1080, 1440x900, 1366x768, 960x640)
  await page.getByRole('button', { name: 'Expand left sidebar' }).click()
  await page.getByRole('button', { name: 'Expand right workspace' }).click()
  for (const vp of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 960, height: 640 },
  ]) {
    await page.setViewportSize(vp)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    )
    assert.equal(overflow, false, `Expected no horizontal overflow at ${vp.width}x${vp.height}`)
  }

  assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`)
  console.log(JSON.stringify({ uiVerification: 'passed', screenshots: 6, consoleErrors: 0 }))
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
