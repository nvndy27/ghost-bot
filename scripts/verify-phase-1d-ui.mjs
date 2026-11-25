import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const repoRoot = process.cwd()
const outDir = join(repoRoot, 'design', 'reviews', 'phase-1d')
await mkdir(outDir, { recursive: true })

const preview = spawn(
  process.execPath,
  [
    join(repoRoot, 'apps', 'desktop', 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4175',
    '--strictPort',
  ],
  { cwd: join(repoRoot, 'apps', 'desktop'), stdio: ['ignore', 'pipe', 'pipe'] },
)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite preview startup timeout')), 10_000)
  preview.stdout.on('data', (chunk) => {
    if (String(chunk).includes('4175')) {
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

const SECTIONS = [
  'General',
  'Appearance',
  'Accounts & Providers',
  'Models',
  'Usage',
  'Personalization',
  'Memory',
  'Tools & MCP',
  'Permissions',
  'Computer Use',
  'Routines',
  'Data & Privacy',
  'Advanced',
]

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(err.message))

  await page.goto('http://127.0.0.1:4175/', { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: 'Open Settings' }).click()
  await page.waitForSelector('nav[aria-label="Settings sections"]')

  // Verify all 13 sections exist and render cleanly
  for (const label of SECTIONS) {
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: label }).click()
    await page.waitForSelector(`.gb-settings-content h2:has-text("${label}")`)
  }

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Accounts & Providers' }).click()
  await page.screenshot({ path: join(outDir, 'settings-accounts-providers.png') })

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Models' }).click()
  await page.screenshot({ path: join(outDir, 'settings-models.png') })

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Usage' }).click()
  await page.screenshot({ path: join(outDir, 'settings-usage.png') })

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Permissions' }).click()
  assert.equal(
    await page.locator('select[aria-label="Default permission mode"] option[value="full-access"]').isDisabled(),
    true,
  )
  await page.screenshot({ path: join(outDir, 'settings-permissions.png') })

  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Advanced' }).click()
  await page.screenshot({ path: join(outDir, 'settings-advanced-reset.png') })

  assert.deepEqual(consoleErrors, [], `Unexpected console errors: ${consoleErrors.join('; ')}`)
  console.log(JSON.stringify({ phase1dUiVerification: 'passed', sections: 13, screenshots: 5 }))
} finally {
  await browser.close()
  preview.kill('SIGTERM')
}
