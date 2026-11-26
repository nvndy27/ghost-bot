import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BwrapIsolatedBrowserWorker } from '../src/browser/bwrap-browser-worker.ts'
import { ComputerUseError } from '../src/contracts/types.ts'

describe('Composed Browser Isolation (Bwrap + Sandboxed Chromium)', () => {
  it('runs real sandboxed Chromium E2E inside bwrap --unshare-all with verified namespace, FS, and network containment', async () => {
    const worker = new BwrapIsolatedBrowserWorker()
    const canaryPath = path.join(os.tmpdir(), `ghost-composed-canary-${Date.now()}.txt`)
    fs.writeFileSync(canaryPath, 'HOST_SECRET_CANARY')

    const hostListener = net.createServer((sock) => sock.end('HOST_LISTENER'))
    await new Promise<void>((resolve) => hostListener.listen(0, '127.0.0.1', () => resolve()))
    const hostPort = (hostListener.address() as { port: number }).port

    try {
      await worker.start()
      const caps = await worker.probeCapabilities()
      assert.equal(caps.sandboxed, true)
      assert.ok(caps.executablePath !== null)

      // 1. Verify namespace membership and FS/network/desktop containment
      const hostNs = {
        user: fs.readlinkSync('/proc/self/ns/user'),
        net: fs.readlinkSync('/proc/self/ns/net'),
        pid: fs.readlinkSync('/proc/self/ns/pid'),
      }
      const iso = await worker.inspectIsolation(canaryPath, hostPort)
      assert.notEqual(iso.ns.user, hostNs.user)
      assert.notEqual(iso.ns.net, hostNs.net)
      assert.notEqual(iso.ns.pid, hostNs.pid)
      assert.equal(iso.canaryReadable, false)
      assert.equal(iso.hostReachable, false)
      assert.equal(iso.wayland, null)
      assert.equal(iso.display, null)
      assert.equal(iso.dbus, null)
      assert.equal(iso.home, '/work')

      // 2. Start synthetic fixture server inside the isolated network namespace
      const { baseUrl } = await worker.startFixtureServer({
        '/': `<!doctype html><html><body>
          <h1 id="h">Bwrap Fixture</h1>
          <input id="inp" type="text" />
          <button id="btn" onclick="
            const v = document.getElementById('inp').value;
            document.getElementById('out').textContent = 'Submitted:' + v;
            document.cookie = 'c=' + encodeURIComponent(v);
            localStorage.setItem('k', v);
          ">Go</button>
          <div id="out">Idle</div>
          <div id="st"></div>
          <script>
            document.getElementById('st').textContent = 'cookie=' + (document.cookie || 'none') + ';ls=' + (localStorage.getItem('k') || 'none');
          </script>
        </body></html>`,
      })

      // 3. Launch two isolated Chrome sessions with chromiumSandbox: true
      const s1 = await worker.createSession({
        scope: {
          ownerId: 'owner-1',
          botId: 'bot-1',
          allowNavigation: true,
          allowObservation: true,
          allowInteraction: true,
          allowedOrigins: [baseUrl],
          maxTabs: 2,
          maxActionsPerBatch: 10,
        },
        headless: true,
      })
      assert.equal(s1.hasNoSandboxFlag, false)

      const s2 = await worker.createSession({
        scope: {
          ownerId: 'owner-1',
          botId: 'bot-2',
          allowNavigation: true,
          allowObservation: true,
          allowInteraction: true,
          allowedOrigins: [baseUrl],
          maxTabs: 2,
          maxActionsPerBatch: 10,
        },
        headless: true,
      })
      assert.equal(s2.hasNoSandboxFlag, false)

      const tab1 = await worker.openTab(s1.sessionId, 'owner-1', 'bot-1')
      const navRes = await worker.executeBatch({
        batchId: 'b-nav',
        sessionId: s1.sessionId,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [{ actionId: 'n1', kind: 'navigate', tabId: tab1.tabId, url: `${baseUrl}/` }],
      })
      assert.equal(navRes.halted, false)

      const obs1 = await worker.observeTab(s1.sessionId, 'owner-1', 'bot-1', tab1.tabId)
      assert.ok(obs1.buffer.byteLength > 100)
      assert.ok(obs1.sanitizedSummary.includes('Bwrap Fixture'))

      const actRes = await worker.executeBatch({
        batchId: 'b-act',
        sessionId: s1.sessionId,
        ownerId: 'owner-1',
        botId: 'bot-1',
        actions: [
          {
            actionId: 't1',
            kind: 'type_text',
            tabId: tab1.tabId,
            selector: '#inp',
            text: 'bwrap-isolated',
            observationId: obs1.observationId,
            navigationGeneration: obs1.navigationGeneration,
          },
          {
            actionId: 'c1',
            kind: 'click_selector',
            tabId: tab1.tabId,
            selector: '#btn',
            observationId: obs1.observationId,
            navigationGeneration: obs1.navigationGeneration,
          },
        ],
      })
      assert.equal(actRes.halted, false)

      const obs2 = await worker.observeTab(s1.sessionId, 'owner-1', 'bot-1', tab1.tabId)
      assert.ok(obs2.sanitizedSummary.includes('Submitted:bwrap-isolated'))

      // Session 2 storage isolation
      const tab2 = await worker.openTab(s2.sessionId, 'owner-1', 'bot-2')
      await worker.executeBatch({
        batchId: 'b-s2',
        sessionId: s2.sessionId,
        ownerId: 'owner-1',
        botId: 'bot-2',
        actions: [{ actionId: 'n2', kind: 'navigate', tabId: tab2.tabId, url: `${baseUrl}/` }],
      })
      const obsS2 = await worker.observeTab(s2.sessionId, 'owner-1', 'bot-2', tab2.tabId)
      assert.ok(obsS2.sanitizedSummary.includes('cookie=none;ls=none'))

      // Emergency stop kills worker and rejects subsequent calls without fallback
      const stopRes = await worker.emergencyStop()
      assert.equal(stopRes.confirmed, true)

      await assert.rejects(
        () => worker.probeCapabilities(),
        (err: unknown) => err instanceof ComputerUseError && err.code === 'BACKEND_DISCONNECTED',
      )
    } finally {
      await worker.close()
      fs.rmSync(canaryPath, { force: true })
      await new Promise<void>((resolve) => hostListener.close(() => resolve()))
    }
  })
})
