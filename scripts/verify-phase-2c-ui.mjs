import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = process.cwd()
const outDir = join(repoRoot, 'design', 'reviews', 'phase-2c')
await mkdir(outDir, { recursive: true })

const preview = spawn(
  process.execPath,
  [
    join(repoRoot, 'apps', 'desktop', 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4177',
    '--strictPort',
  ],
  { cwd: join(repoRoot, 'apps', 'desktop'), stdio: ['ignore', 'pipe', 'pipe'] },
)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview startup timeout')), 10_000)
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('4177')) {
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

  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'networkidle' })
  await page.waitForSelector('text=Chief of Staff')

  // 1. Trigger mock approval request and verify Approve once / Deny UI
  const composer = page.getByLabel('Message Chief of Staff')
  await composer.fill('Please request approval for edit')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.waitForSelector('button:has-text("Approve once")', { timeout: 5000 })
  await page.screenshot({ path: join(outDir, '01-approval-pending.png') })

  // 2. Click Approve once and verify resolved state
  await page.getByRole('button', { name: 'Approve once' }).click()
  await page.waitForSelector('text=Approved once (mock)', { timeout: 5000 })
  await page.screenshot({ path: join(outDir, '02-approval-approved-once.png') })

  // 3. Trigger another approval and Deny
  await composer.fill('Request another approval')
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.waitForSelector('button:has-text("Deny")', { timeout: 5000 })
  await page.getByRole('button', { name: 'Deny' }).click()
  await page.waitForSelector('text=Denied (mock)', { timeout: 5000 })
  await page.screenshot({ path: join(outDir, '03-approval-denied.png') })

  assert.equal(errors.length, 0, `Page errors occurred: ${errors.join('; ')}`)
  console.log('Phase 2C Playwright UI verification passed (3 screenshots saved).')
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
