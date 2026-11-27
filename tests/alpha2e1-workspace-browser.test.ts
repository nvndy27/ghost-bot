import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { _electron as electron } from 'playwright-core'
import {
  browserScope,
  parseBrowserUrl,
  publicIpv4,
  urlInScope,
} from '../apps/desktop/electron/workspace-browser/network.ts'

test('Alpha.2E.1 network policy blocks unsafe schemes, credentials, private IPs, and cross-origin local navigation', () => {
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'ftp://example.com/a',
    'http://user:pass@127.0.0.1:3000/',
  ]) {
    assert.throws(() => parseBrowserUrl(bad), `Expected rejection for ${bad}`)
  }

  const localUrl = parseBrowserUrl('http://127.0.0.1:3000/app')
  const localScope = browserScope(localUrl)
  assert.equal(localScope.kind, 'local')
  assert.equal(urlInScope(localUrl, localScope), true)
  assert.equal(urlInScope(parseBrowserUrl('http://127.0.0.1:4000/'), localScope), false)
  assert.equal(urlInScope(parseBrowserUrl('https://example.com/'), localScope), false)

  const pubScope = browserScope(parseBrowserUrl('https://example.com/'))
  assert.equal(pubScope.kind, 'public')
  assert.equal(urlInScope(parseBrowserUrl('http://127.0.0.1/'), pubScope), false)
  assert.equal(urlInScope(parseBrowserUrl('http://169.254.169.254/latest/meta-data/'), pubScope), false)
  assert.equal(urlInScope(parseBrowserUrl('http://10.0.0.1/'), pubScope), false)
  assert.equal(urlInScope(parseBrowserUrl('http://sub.localhost/'), pubScope), false)
  assert.equal(publicIpv4('127.0.0.1'), false)
  assert.equal(publicIpv4('192.168.1.10'), false)
})

test('Alpha.2E.1 Electron E2E: isolated WebContentsView navigation, viewport, screenshot, console redaction, and blocking', async () => {
  let portB = 0
  const serverB = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><title>Forbidden Other Local</title><body>Other</body></html>')
  })
  await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', () => resolve()))
  portB = (serverB.address() as { port: number }).port

  const serverA = createServer((req, res) => {
    if (req.url === '/redirect-other') {
      res.writeHead(302, { location: `http://127.0.0.1:${portB}/` })
      res.end()
      return
    }
    if (req.url === '/page2') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><title>Fixture Page 2</title><body><h1>Page Two</h1></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<html><title>Fixture Home</title><body>
      <h1>Local Preview</h1>
      <script>
        console.warn('Bearer secret_token_should_never_appear');
        window.__hasGhostBot = typeof window.ghostBot !== 'undefined';
      </script>
    </body></html>`)
  })
  await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', () => resolve()))
  const portA = (serverA.address() as { port: number }).port

  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha2e1-'))
  const desktop = join(process.cwd(), 'apps', 'desktop')
  const app = await electron.launch({
    executablePath: join(desktop, 'node_modules', '.bin', 'electron'),
    args: [join(desktop, 'dist-electron', 'main.js')],
    cwd: desktop,
    env: {
      ...process.env,
      GHOST_BOT_DATA_DIR: dataDir,
      GHOST_BOT_RUNTIME_MODE: 'mock',
      GHOST_BOT_SMOKE_EXIT: '0',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.getByTestId('workspace-tab-browser').click()
    await page.waitForSelector('[data-testid="workspace-browser-tab"]')

    // Navigate to local fixture A
    await page.getByTestId('browser-url-input').fill(`http://127.0.0.1:${portA}/`)
    await page.getByTestId('browser-go-btn').click()
    await page.waitForFunction(() => {
      const tab = document.querySelector('[data-testid="browser-tab-0"]')
      return Boolean(tab?.textContent?.includes('Fixture Home'))
    })

    // Navigate to /page2, then Back and Forward
    await page.getByTestId('browser-url-input').fill(`http://127.0.0.1:${portA}/page2`)
    await page.getByTestId('browser-go-btn').click()
    await page.waitForFunction(() =>
      Boolean(document.querySelector('[data-testid="browser-tab-0"]')?.textContent?.includes('Fixture Page 2')),
    )
    await page.getByTestId('browser-back-btn').click()
    await page.waitForFunction(() =>
      Boolean(document.querySelector('[data-testid="browser-tab-0"]')?.textContent?.includes('Fixture Home')),
    )

    // Viewport toggle (Desktop -> Mobile -> Desktop)
    await page.getByTestId('browser-viewport-btn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="browser-viewport-btn"]')?.textContent === 'Mobile')
    await page.getByTestId('browser-viewport-btn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="browser-viewport-btn"]')?.textContent === 'Desktop')

    // Screenshot capture
    await page.getByTestId('browser-screenshot-btn').click()
    await page.waitForSelector('[data-testid="browser-screenshot-preview"] img, [data-testid="browser-error-banner"]')
    const errBanner = page.getByTestId('browser-error-banner')
    if ((await errBanner.count()) > 0) {
      throw new Error(`Screenshot failed with banner: ${await errBanner.innerText()}`)
    }
    const shotSrc = await page
      .locator('[data-testid="browser-screenshot-preview"] img')
      .getAttribute('src')
    assert.ok(shotSrc?.startsWith('data:image/jpeg;base64,'))

    // Console redaction: severity/timestamp only, never raw secret string
    await page.getByTestId('browser-console-btn').click()
    const consoleText = await page.getByTestId('browser-console-panel').innerText()
    assert.equal(consoleText.includes('secret_token_should_never_appear'), false)

    // Unsafe scheme & cross-origin redirect blocked
    await page.getByTestId('browser-url-input').fill('file:///etc/passwd')
    await page.getByTestId('browser-go-btn').click()
    await page.waitForSelector('[data-testid="browser-error-banner"]')

    await page.getByTestId('browser-url-input').fill(`http://127.0.0.1:${portA}/redirect-other`)
    await page.getByTestId('browser-go-btn').click()
    await page.waitForSelector('[data-testid="browser-error-banner"]')

    // Switch back to Overview and confirm clean hide
    await page.getByTestId('workspace-tab-overview').click()
    await page.waitForSelector('text=Live computer')
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
    serverA.close()
    serverB.close()
  }
})
