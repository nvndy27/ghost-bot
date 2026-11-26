import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { PlaywrightBrowserBackend } from '../src/browser/playwright-browser-backend.ts'
import { ComputerUseError } from '../src/contracts/types.ts'

let server: http.Server
let baseUrl = ''

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/next') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>Next</title></head><body><h1>Next Page</h1></body></html>')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html>
      <html>
        <head><title>Sandbox Fixture</title></head>
        <body style="height: 2000px;">
          <h1 id="heading">Hello Sandbox</h1>
          <input id="nameInput" type="text" />
          <button id="submitBtn" onclick="
            const val = document.getElementById('nameInput').value;
            document.getElementById('result').textContent = 'Submitted:' + val;
            document.cookie = 'session_marker=' + encodeURIComponent(val);
            localStorage.setItem('stored_marker', val);
          ">Submit</button>
          <div id="result">Idle</div>
          <div id="storageCheck"></div>
          <script>
            document.getElementById('storageCheck').textContent =
              'cookie=' + (document.cookie || 'none') + ';ls=' + (localStorage.getItem('stored_marker') || 'none');
          </script>
        </body>
      </html>`)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      baseUrl = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('PlaywrightBrowserBackend Isolated E2E', () => {
  it('runs full sandboxed E2E against synthetic loopback fixture with session isolation and clean teardown', async () => {
    const backend = new PlaywrightBrowserBackend()
    const caps = await backend.probeCapabilities()
    assert.equal(caps.sandboxed, true)
    assert.ok(caps.executablePath !== null)

    const { sessionId: s1, tempProfileDir: dir1 } = await backend.createSession({
      scope: {
        ownerId: 'owner-1',
        botId: 'bot-1',
        allowNavigation: true,
        allowObservation: true,
        allowInteraction: true,
        allowedOrigins: [baseUrl],
        maxTabs: 3,
        maxActionsPerBatch: 10,
      },
      headless: true,
    })

    const { sessionId: s2, tempProfileDir: dir2 } = await backend.createSession({
      scope: {
        ownerId: 'owner-1',
        botId: 'bot-2',
        allowNavigation: true,
        allowObservation: true,
        allowInteraction: true,
        allowedOrigins: [baseUrl],
        maxTabs: 3,
        maxActionsPerBatch: 10,
      },
      headless: true,
    })

    try {
      const tab1 = await backend.openTab(s1, 'owner-1', 'bot-1')
      // Navigate, observe, type, click, scroll
      const navRes = await backend.executeBatch({
        batchId: 'b-nav',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [{ actionId: 'nav-1', kind: 'navigate', tabId: tab1.tabId, url: `${baseUrl}/` }],
      })
      assert.equal(navRes.halted, false)

      const obs1 = await backend.observeTab(s1, 'owner-1', 'bot-1', tab1.tabId)
      assert.equal(obs1.isIsolatedBrowser, true)
      assert.ok(obs1.byteLength > 100)
      assert.ok(obs1.sanitizedSummary.includes('Hello Sandbox'))

      const interactRes = await backend.executeBatch({
        batchId: 'b-act',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [
          {
            actionId: 'type-1',
            kind: 'type_text',
            tabId: tab1.tabId,
            selector: '#nameInput',
            text: 'ghost-test-value',
            observationId: obs1.observationId,
            navigationGeneration: obs1.navigationGeneration,
          },
          {
            actionId: 'click-1',
            kind: 'click_selector',
            tabId: tab1.tabId,
            selector: '#submitBtn',
            observationId: obs1.observationId,
            navigationGeneration: obs1.navigationGeneration,
          },
          {
            actionId: 'scroll-1',
            kind: 'scroll',
            tabId: tab1.tabId,
            deltaX: 0,
            deltaY: 200,
            observationId: obs1.observationId,
            navigationGeneration: obs1.navigationGeneration,
          },
        ],
      })
      assert.equal(interactRes.halted, false)

      const obs2 = await backend.observeTab(s1, 'owner-1', 'bot-1', tab1.tabId)
      assert.ok(obs2.sanitizedSummary.includes('Submitted:ghost-test-value'))

      // Second isolated session must NOT see cookies/localStorage from session 1
      const tab2 = await backend.openTab(s2, 'owner-1', 'bot-2')
      await backend.executeBatch({
        batchId: 'b-s2-nav',
        sessionId: s2,
        ownerId: 'owner-1',
        botId: 'bot-2',
        actions: [{ actionId: 's2-nav', kind: 'navigate', tabId: tab2.tabId, url: `${baseUrl}/` }],
      })
      const obsS2 = await backend.observeTab(s2, 'owner-1', 'bot-2', tab2.tabId)
      assert.ok(obsS2.sanitizedSummary.includes('cookie=none;ls=none'))

      // Unauthorized destination rejected without external traffic
      const badNav = await backend.executeBatch({
        batchId: 'b-bad-nav',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [{ actionId: 'bad-nav-1', kind: 'navigate', tabId: tab1.tabId, url: 'https://example.invalid/' }],
      })
      assert.equal(badNav.halted, true)
      assert.equal(badNav.entries[0]?.errorCode, 'SCOPE_FORBIDDEN')

      // Stale observation rejected after navigation increments navigationGeneration
      await backend.executeBatch({
        batchId: 'b-next',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [{ actionId: 'nav-2', kind: 'navigate', tabId: tab1.tabId, url: `${baseUrl}/next` }],
      })
      const staleRes = await backend.executeBatch({
        batchId: 'b-stale',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [
          {
            actionId: 'stale-click',
            kind: 'click_selector',
            tabId: tab1.tabId,
            selector: 'h1',
            observationId: obs2.observationId,
            navigationGeneration: obs2.navigationGeneration,
          },
        ],
      })
      assert.equal(staleRes.halted, true)
      assert.equal(staleRes.entries[0]?.errorCode, 'STALE_OBSERVATION')

      // Batch cancellation
      backend.cancelBatch(s1, 'b-cancelled')
      const cancelRes = await backend.executeBatch({
        batchId: 'b-cancelled',
        sessionId: s1,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [{ actionId: 'c-wait', kind: 'wait', durationMs: 5 }],
      })
      assert.equal(cancelRes.halted, true)
      assert.equal(cancelRes.entries[0]?.status, 'cancelled')

      // Action ledger contains sanitized metadata and NO raw typed text
      const ledger = backend.getActionLedger(s1, 'owner-1')
      assert.ok(ledger.length >= 4)
      assert.ok(!JSON.stringify(ledger).includes('ghost-test-value'))

      // Cross-owner ledger access rejected
      assert.throws(
        () => backend.getActionLedger(s1, 'other-owner'),
        (err: unknown) => err instanceof ComputerUseError && err.code === 'SCOPE_FORBIDDEN',
      )
    } finally {
      await backend.closeAll()
    }

    // Verify temporary browser profile directories are cleaned up
    assert.equal(fs.existsSync(dir1), false)
    assert.equal(fs.existsSync(dir2), false)
  })
})
