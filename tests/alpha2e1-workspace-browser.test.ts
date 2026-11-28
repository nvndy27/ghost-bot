import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertPackagedRendererSandbox, launchWorkspaceElectron } from './helpers/workspace-electron.ts'
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

test('Alpha.2E.1 Electron E2E: isolated WebContentsView navigation, viewport, screenshot, console redaction, and cleanup', async (t) => {
  let blockedOriginRequests = 0
  const serverB = createServer((_req, res) => {
    blockedOriginRequests += 1
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><title>Forbidden Other Local</title><body>Other</body></html>')
  })
  await new Promise<void>((resolve) => serverB.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => {
    serverB.close()
    serverB.closeAllConnections()
  })
  const portB = (serverB.address() as { port: number }).port

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
        window.__hasNode = typeof require !== 'undefined' || typeof process !== 'undefined';
      </script>
    </body></html>`)
  })
  await new Promise<void>((resolve) => serverA.listen(0, '127.0.0.1', () => resolve()))
  t.after(() => {
    serverA.close()
    serverA.closeAllConnections()
  })
  const portA = (serverA.address() as { port: number }).port

  const dataDir = await mkdtemp(join(tmpdir(), 'ghost-alpha2e1-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const app = await launchWorkspaceElectron(dataDir)

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

    const target = await app.evaluate(async ({ webContents }, url) => {
      const preview = webContents.getAllWebContents().find((entry) => entry.getURL() === url)
      if (!preview) throw new Error('Missing isolated browser preview')
      const isolated = await preview.executeJavaScript('window.__hasGhostBot === false && window.__hasNode === false')
      const preferences = preview.getLastWebPreferences()
      return {
        id: preview.id,
        rendererPid: preview.getOSProcessId(),
        isolated,
        sandbox: preferences?.sandbox,
        contextIsolation: preferences?.contextIsolation,
        node: preferences?.nodeIntegration,
      }
    }, `http://127.0.0.1:${portA}/`)
    const { id: previewId, rendererPid, ...security } = target
    assert.deepEqual(security, { isolated: true, sandbox: true, contextIsolation: true, node: false })
    await assertPackagedRendererSandbox(rendererPid)

    // Renderer overlays must occlude native views without destroying the isolated session.
    await page.evaluate(() => {
      const dialog = document.createElement('div')
      dialog.role = 'dialog'
      dialog.id = 'workspace-overlay-fixture'
      dialog.textContent = 'Synthetic overlay fixture'
      document.body.append(dialog)
    })
    await page.waitForFunction(async () => {
      const state = await window.ghostBot!.workspaceBrowserCommand({ kind: 'state' })
      return state.tabs.length === 1
    })
    const attached = () => app.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.getAllWindows()[0]
      return window.contentView.children.some((view) =>
        'webContents' in view && (view.webContents as { id: number }).id === id && view.getVisible())
    }, previewId)
    const waitForAttached = async (expected: boolean) => {
      for (let attempt = 0; attempt < 100 && (await attached()) !== expected; attempt++) {
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      }
      assert.equal(await attached(), expected)
    }
    for (let attempt = 0; attempt < 100 && await attached(); attempt++) {
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    }
    assert.equal(await attached(), false)
    await page.evaluate(() => document.getElementById('workspace-overlay-fixture')?.remove())
    await waitForAttached(true)

    // Real shared Usage and Settings dialogs must occlude and then restore the native view.
    await page.getByRole('button', { name: 'Provider usage' }).click()
    await page.getByRole('dialog', { name: 'Provider usage' }).waitFor()
    await waitForAttached(false)
    await page.getByRole('button', { name: 'Close provider usage' }).click()
    await waitForAttached(true)
    await page.getByRole('button', { name: 'Open Settings' }).click()
    await page.getByRole('dialog').waitFor()
    await waitForAttached(false)
    await page.keyboard.press('Escape')
    await waitForAttached(true)

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
    await page.waitForFunction(() => document.querySelector('[data-testid="browser-viewport-btn"]')?.getAttribute('aria-pressed') === 'true')
    await page.getByTestId('browser-viewport-btn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="browser-viewport-btn"]')?.getAttribute('aria-pressed') === 'false')

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
    const consolePanel = page.getByTestId('browser-console-panel')
    await consolePanel.getByText(/redacted untrusted output/).first().waitFor()
    const consoleText = await consolePanel.innerText()
    assert.equal(consoleText.includes('secret_token_should_never_appear'), false)

    // Unsafe scheme & cross-origin redirect blocked
    await page.getByTestId('browser-url-input').fill('file:///etc/passwd')
    await page.getByTestId('browser-go-btn').click()
    await page.waitForSelector('[data-testid="browser-error-banner"]')

    await page.getByTestId('browser-url-input').fill(`http://127.0.0.1:${portA}/redirect-other`)
    await page.getByTestId('browser-go-btn').click()
    await page.getByTestId('browser-error-banner').getByText(/redirect|navigation|could not be loaded/i).waitFor()
    assert.equal(blockedOriginRequests, 0)

    // Hiding Browser must detach the overlay from the visible panel.
    await page.getByTestId('workspace-tab-overview').click()
    await page.getByRole('button', { name: 'Open Live Viewer', exact: true }).waitFor()
    await page.getByTestId('workspace-tab-browser').click()
    await page.getByRole('button', { name: 'Close browser tab 1' }).click()
    await page.getByTestId('browser-tab-0').waitFor({ state: 'detached' })
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id) == null, previewId), true)
  } finally {
    await app.close()
  }
})
