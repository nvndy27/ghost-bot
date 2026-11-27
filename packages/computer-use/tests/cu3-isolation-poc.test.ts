import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { WestonHeadlessVirtualDesktop } from '../src/backends/weston-virtual-desktop.ts'
import { PlaywrightBrowserBackend } from '../src/browser/playwright-browser-backend.ts'
import { ComputerUseError } from '../src/contracts/types.ts'
import { BubblewrapIsolationRunner } from '../src/isolation/bwrap-isolation-worker.ts'

describe('CU.3 OS Isolation, Chromium Sandbox & Weston PoC', () => {
  it('verifies Chromium sandbox is genuinely enabled (no --no-sandbox) in PlaywrightBrowserBackend', async () => {
    const backend = new PlaywrightBrowserBackend()
    const { sessionId, tempProfileDir } = await backend.createSession({
      scope: {
        ownerId: 'owner-1',
        botId: 'bot-1',
        allowNavigation: true,
        allowObservation: true,
        allowInteraction: false,
        allowedOrigins: ['http://127.0.0.1:1'],
        maxTabs: 1,
        maxActionsPerBatch: 5,
      },
      headless: true,
    })

    try {
      const cmdline = execFileSync('pgrep', ['-af', tempProfileDir], { encoding: 'utf8' })
      assert.equal(cmdline.includes('--no-sandbox'), false)
      assert.ok(sessionId.startsWith('cu_brow_'))
    } finally {
      await backend.closeSession(sessionId, 'owner-1')
    }
    assert.equal(fs.existsSync(tempProfileDir), false)
  })

  it('enforces filesystem, network, and desktop socket containment inside unprivileged bwrap', async () => {
    const runner = new BubblewrapIsolationRunner()
    const caps = await runner.probeCapabilities()
    assert.equal(caps.bubblewrapAvailable, true)
    assert.equal(caps.networkNamespaceSupported, true)
    assert.equal(caps.hostWaylandExposed, false)
    assert.equal(caps.hostHomeExposed, false)

    // Create unauthorized host-side canary file and host-side TCP listener
    const canaryPath = path.join(os.tmpdir(), `ghost-cu3-canary-${Date.now()}.txt`)
    fs.writeFileSync(canaryPath, 'UNAUTHORIZED_HOST_CANARY')

    const hostServer = net.createServer((sock) => sock.end('HOST_SECRET'))
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', () => resolve()))
    const hostPort = (hostServer.address() as { port: number }).port

    try {
      const res = await runner.runIsolatedNodeScript({
        workspaceFiles: {
          'fixture.json': JSON.stringify({ authorized: true, label: 'synthetic-work' }),
        },
        script: `
          import fs from 'node:fs';
          import net from 'node:net';
          const fixture = JSON.parse(fs.readFileSync('/work/fixture.json', 'utf8'));
          let canaryReadable = false;
          try { fs.readFileSync(${JSON.stringify(canaryPath)}, 'utf8'); canaryReadable = true; } catch {}
          const hostReachable = await new Promise((resolve) => {
            const s = net.connect(${hostPort}, '127.0.0.1');
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('error', () => resolve(false));
            setTimeout(() => { s.destroy(); resolve(false); }, 300);
          });
          console.log(JSON.stringify({
            fixture,
            canaryReadable,
            hostReachable,
            wayland: process.env.WAYLAND_DISPLAY ?? null,
            display: process.env.DISPLAY ?? null,
            home: process.env.HOME ?? null,
          }));
        `,
        timeoutMs: 5000,
      })

      assert.equal(res.exitCode, 0)
      assert.equal(res.workspaceCleaned, true)
      const parsed = JSON.parse(res.stdout.trim()) as {
        fixture: { authorized: boolean }
        canaryReadable: boolean
        hostReachable: boolean
        wayland: string | null
        display: string | null
        home: string | null
      }
      assert.equal(parsed.fixture.authorized, true)
      assert.equal(parsed.canaryReadable, false)
      assert.equal(parsed.hostReachable, false)
      assert.equal(parsed.wayland, null)
      assert.equal(parsed.display, null)
      assert.equal(parsed.home, '/work')
    } finally {
      fs.rmSync(canaryPath, { force: true })
      await new Promise<void>((resolve) => hostServer.close(() => resolve()))
    }
  })

  it('starts and cleanly terminates isolated Weston headless virtual desktop without touching host display', async () => {
    const vd = new WestonHeadlessVirtualDesktop()
    const caps = await vd.probeCapabilities()
    assert.equal(caps.compositorAvailable, true)
    assert.equal(caps.isolatedSocketSupported, true)
    assert.equal(caps.frameCaptureSupported, false)
    assert.equal(caps.hostDesktopIsolated, true)

    const session = await vd.startSession({
      ownerId: 'owner-1',
      botId: 'bot-1',
      width: 800,
      height: 600,
    })
    assert.equal(session.state, 'running')
    assert.equal(fs.existsSync(path.join(session.runtimeDir, session.waylandSocket)), true)

    await assert.rejects(
      () => vd.captureFrame(session.sessionId, 'owner-1'),
      (err: unknown) => err instanceof ComputerUseError && err.code === 'UNSUPPORTED_CAPABILITY',
    )

    const stop = await vd.stopSession(session.sessionId, 'owner-1')
    assert.equal(stop.confirmed, true)
    assert.equal(fs.existsSync(session.runtimeDir), false)
  })
})
