import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { PlaywrightBrowserBackend } from './playwright-browser-backend.ts'

function loadBundledOrWorkspacePlaywright(): unknown {
  const vendorEntry = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'vendor',
    'playwright-core',
    'index.js',
  )
  const req = createRequire(import.meta.url)
  if (fs.existsSync(vendorEntry)) {
    return req(vendorEntry)
  }
  const nmEntry = '/nm/playwright-core/index.js'
  if (fs.existsSync(nmEntry)) {
    return req(nmEntry)
  }
  return req('playwright-core')
}

const playwrightCore = loadBundledOrWorkspacePlaywright()

function readProcCmdlinesContaining(needle: string): string[] {
  const matches: string[] = []
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const raw = fs.readFileSync(`/proc/${entry}/cmdline`)
      if (raw.length === 0) continue
      const cmdline = raw.toString('utf8').replace(/\0+/g, ' ').trim()
      if (cmdline.includes(needle)) matches.push(cmdline)
    } catch {
      // process may have exited
    }
  }
  return matches
}

const BROWSER_EXECUTABLE_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
]

function resolvePackagedOrHostExecutable(): string | undefined {
  for (const candidate of BROWSER_EXECUTABLE_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function resolvePlaywrightPath(): string | undefined {
  const nmCandidate = '/nm/playwright-core/index.mjs'
  if (fs.existsSync(nmCandidate)) return nmCandidate
  return undefined
}

const backend = new PlaywrightBrowserBackend()
let fixtureServer: http.Server | null = null
let fixtureBaseUrl: string | null = null

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', async (line: string) => {
  if (!line.trim()) return
  let req: { id: number; method: string; params?: Record<string, unknown> }
  try {
    req = JSON.parse(line) as { id: number; method: string; params?: Record<string, unknown> }
  } catch {
    return
  }

  try {
    let result: unknown
    const params = req.params ?? {}
    switch (req.method) {
      case 'probeCapabilities': {
        result = await backend.probeCapabilities({
          playwrightModulePath: resolvePlaywrightPath(),
          playwrightModule: playwrightCore,
          executablePath: resolvePackagedOrHostExecutable(),
        })
        break
      }
      case 'startFixtureServer': {
        const routes = (params.routes as Record<string, string>) ?? {}
        fixtureServer = http.createServer((hReq, hRes) => {
          const body = routes[hReq.url || '/'] ?? routes['/'] ?? '<h1>Missing</h1>'
          hRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          hRes.end(body)
        })
        await new Promise<void>((resolve) => fixtureServer!.listen(0, '127.0.0.1', () => resolve()))
        const addr = fixtureServer.address() as net.AddressInfo
        fixtureBaseUrl = `http://127.0.0.1:${addr.port}`
        result = { baseUrl: fixtureBaseUrl }
        break
      }
      case 'inspectIsolation': {
        const canaryPath = String(params.canaryPath ?? '')
        const hostPort = Number(params.hostPort ?? 0)
        let canaryReadable = false
        try {
          fs.readFileSync(canaryPath, 'utf8')
          canaryReadable = true
        } catch {
          // expected when isolated
        }
        const hostReachable = await new Promise<boolean>((resolve) => {
          const s = net.connect(hostPort, '127.0.0.1')
          s.on('connect', () => {
            s.destroy()
            resolve(true)
          })
          s.on('error', () => resolve(false))
          setTimeout(() => {
            s.destroy()
            resolve(false)
          }, 300)
        })
        const ns = {
          user: fs.readlinkSync('/proc/self/ns/user'),
          net: fs.readlinkSync('/proc/self/ns/net'),
          pid: fs.readlinkSync('/proc/self/ns/pid'),
        }
        result = {
          canaryReadable,
          hostReachable,
          ns,
          home: process.env.HOME ?? null,
          wayland: process.env.WAYLAND_DISPLAY ?? null,
          display: process.env.DISPLAY ?? null,
          dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
        }
        break
      }
      case 'createSession': {
        const cfg = {
          ...(params as Record<string, unknown>),
          executablePath: resolvePackagedOrHostExecutable(),
          playwrightModulePath: resolvePlaywrightPath(),
          playwrightModule: playwrightCore,
        }
        const created = await backend.createSession(
          cfg as unknown as Parameters<PlaywrightBrowserBackend['createSession']>[0],
        )
        const cmdlines = readProcCmdlinesContaining(created.tempProfileDir)
        if (cmdlines.length === 0) {
          throw new Error('Unable to inspect launched browser process /proc cmdline for sandbox verification')
        }
        result = { ...created, hasNoSandboxFlag: cmdlines.some((c) => c.includes('--no-sandbox')) }
        break
      }
      case 'openTab':
        result = await backend.openTab(
          String(params.sessionId),
          String(params.ownerId),
          String(params.botId),
        )
        break
      case 'observeTab': {
        const obs = await backend.observeTab(
          String(params.sessionId),
          String(params.ownerId),
          String(params.botId),
          String(params.tabId),
        )
        result = {
          ...obs,
          bufferBase64: Buffer.from(obs.buffer).toString('base64'),
          buffer: undefined,
        }
        break
      }
      case 'executeBatch':
        result = await backend.executeBatch(
          params as unknown as Parameters<PlaywrightBrowserBackend['executeBatch']>[0],
        )
        break
      case 'cancelBatch':
        backend.cancelBatch(String(params.sessionId), String(params.batchId))
        result = { ok: true }
        break
      case 'closeSession':
        await backend.closeSession(String(params.sessionId), String(params.ownerId))
        result = { ok: true }
        break
      case 'closeAll':
        await backend.closeAll()
        if (fixtureServer) await new Promise<void>((r) => fixtureServer!.close(() => r()))
        result = { ok: true }
        break
      default:
        throw new Error('Unknown method: ' + req.method)
    }
    send({ id: req.id, ok: true, result })
  } catch (err) {
    const e = err as { code?: string; message?: string }
    send({
      id: req.id,
      ok: false,
      error: { code: e?.code || 'BACKEND_FAILED', message: e?.message || 'Worker error' },
    })
  }
})
