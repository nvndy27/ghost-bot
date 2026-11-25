import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = process.cwd()
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2a')
await mkdir(outDir, { recursive: true })

const preview = spawn(
  process.execPath,
  [
    join(repoRoot, 'apps', 'desktop', 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4176',
    '--strictPort',
  ],
  { cwd: join(repoRoot, 'apps', 'desktop'), stdio: ['ignore', 'pipe', 'pipe'] },
)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview startup timeout')), 10_000)
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('4176')) {
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
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('http://127.0.0.1:4176/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Chief of Staff')

  // 1. Default workspace dark theme
  await page.screenshot({ path: join(outDir, '01-workspace-dark.png') })

  // 2. Send a mock prompt and wait for completion
  const composer = page.getByLabel('Message Chief of Staff')
  await composer.fill('Summarize Phase 2A persistence architecture')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.waitForSelector('text=Simulated mock reply', { timeout: 5000 })
  await page.screenshot({ path: join(outDir, '02-mock-stream-completed.png') })

  // 3. Trigger approval flow
  await composer.fill('Please request approval for edit')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.waitForSelector('text=Approval required', { timeout: 5000 })
  await page.screenshot({ path: join(outDir, '03-approval-card.png') })

  // 4. Light theme verification
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.getByLabel('Theme').selectOption('light')
  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.screenshot({ path: join(outDir, '04-light-theme.png') })

  assert.equal(errors.length, 0, `Page errors occurred: ${errors.join('; ')}`)
  console.log('Phase 2A Playwright UI verification passed (4 screenshots saved).')
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
