import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BrowserActionBatch,
  BrowserBatchResult,
  BrowserCapabilities,
  BrowserObservation,
  BrowserSessionConfig,
  BrowserTabInfo,
} from '../contracts/browser.ts'
import { ComputerUseError } from '../contracts/types.ts'
import { getMinimalEtcBinds } from '../isolation/bwrap-isolation-worker.ts'

const MAX_RPC_LINE_BYTES = 4 * 1024 * 1024

interface RpcResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: { code?: string; message?: string }
}

const WORKER_SCRIPT = `
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import readline from 'node:readline';
import { PlaywrightBrowserBackend } from '/pkg/src/browser/playwright-browser-backend.ts';

const backend = new PlaywrightBrowserBackend();
let fixtureServer = null;
let fixtureBaseUrl = null;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  try {
    let result;
    switch (req.method) {
      case 'probeCapabilities': {
        result = await backend.probeCapabilities({
          playwrightModulePath: '/nm/playwright-core/index.mjs',
          executablePath: '/usr/bin/google-chrome',
        });
        break;
      }
      case 'startFixtureServer': {
        const routes = req.params.routes || {};
        fixtureServer = http.createServer((hReq, hRes) => {
          const body = routes[hReq.url || '/'] ?? routes['/'] ?? '<h1>Missing</h1>';
          hRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          hRes.end(body);
        });
        await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
        const addr = fixtureServer.address();
        fixtureBaseUrl = 'http://127.0.0.1:' + addr.port;
        result = { baseUrl: fixtureBaseUrl };
        break;
      }
      case 'inspectIsolation': {
        const { canaryPath, hostPort } = req.params;
        let canaryReadable = false;
        try { fs.readFileSync(canaryPath, 'utf8'); canaryReadable = true; } catch {}
        const hostReachable = await new Promise((resolve) => {
          const s = net.connect(hostPort, '127.0.0.1');
          s.on('connect', () => { s.destroy(); resolve(true); });
          s.on('error', () => resolve(false));
          setTimeout(() => { s.destroy(); resolve(false); }, 300);
        });
        const ns = {
          user: fs.readlinkSync('/proc/self/ns/user'),
          net: fs.readlinkSync('/proc/self/ns/net'),
          pid: fs.readlinkSync('/proc/self/ns/pid'),
        };
        result = {
          canaryReadable,
          hostReachable,
          ns,
          home: process.env.HOME ?? null,
          wayland: process.env.WAYLAND_DISPLAY ?? null,
          display: process.env.DISPLAY ?? null,
          dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
        };
        break;
      }
      case 'createSession': {
        const cfg = {
          ...req.params,
          executablePath: '/usr/bin/google-chrome',
          playwrightModulePath: '/nm/playwright-core/index.mjs',
        };
        const created = await backend.createSession(cfg);
        const cmdline = execFileSync('pgrep', ['-af', created.tempProfileDir], { encoding: 'utf8' });
        result = { ...created, hasNoSandboxFlag: cmdline.includes('--no-sandbox') };
        break;
      }
      case 'openTab':
        result = await backend.openTab(req.params.sessionId, req.params.ownerId, req.params.botId);
        break;
      case 'observeTab': {
        const obs = await backend.observeTab(req.params.sessionId, req.params.ownerId, req.params.botId, req.params.tabId);
        result = { ...obs, bufferBase64: Buffer.from(obs.buffer).toString('base64'), buffer: undefined };
        break;
      }
      case 'executeBatch':
        result = await backend.executeBatch(req.params);
        break;
      case 'cancelBatch':
        backend.cancelBatch(req.params.sessionId, req.params.batchId);
        result = { ok: true };
        break;
      case 'closeSession':
        await backend.closeSession(req.params.sessionId, req.params.ownerId);
        result = { ok: true };
        break;
      case 'closeAll':
        await backend.closeAll();
        if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
        result = { ok: true };
        break;
      default:
        throw new Error('Unknown method: ' + req.method);
    }
    send({ id: req.id, ok: true, result });
  } catch (err) {
    send({ id: req.id, ok: false, error: { code: err?.code || 'BACKEND_FAILED', message: err?.message || 'Worker error' } });
  }
});
`

/**
 * Composed isolated browser worker:
 * Computer Use Controller -> BwrapIsolatedBrowserWorker -> bwrap (--unshare-all --cap-drop ALL) -> PlaywrightBrowserBackend (chromiumSandbox: true).
 * Never falls back to an unisolated host browser.
 */
export class BwrapIsolatedBrowserWorker {
  private child: ChildProcess | null = null
  private workDir: string | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private buffer = ''
  private closed = false

  async start(): Promise<void> {
    if (this.child) return
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const pkgDir = path.resolve(thisDir, '../..')
    const rootDir = path.resolve(pkgDir, '../..')
    const nmDir = path.join(rootDir, 'node_modules')
    if (!fs.existsSync(nmDir)) {
      throw new ComputerUseError('BACKEND_FAILED', 'Workspace node_modules not found for isolated worker')
    }

    this.workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cu-bwrap-brow-'))
    fs.chmodSync(this.workDir, 0o700)

    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      ...(fs.existsSync('/opt') ? ['--ro-bind', '/opt', '/opt'] : []),
      ...getMinimalEtcBinds(),
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/bin',
      '/bin',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/dev/shm',
      '--ro-bind',
      pkgDir,
      '/pkg',
      '--ro-bind',
      nmDir,
      '/nm',
      '--bind',
      this.workDir,
      '/work',
      '--chdir',
      '/work',
      '/usr/bin/node',
      '--input-type=module',
      '-e',
      WORKER_SCRIPT,
    ]

    const child = spawn('bwrap', args, {
      env: { PATH: '/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RPC_LINE_BYTES) {
        this.rejectAll(new ComputerUseError('BACKEND_FAILED', 'Isolated browser worker exceeded max RPC frame size'))
        void this.emergencyStop()
        return
      }
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        idx = this.buffer.indexOf('\n')
        if (!line.trim()) continue
        const msg = JSON.parse(line) as RpcResponse
        const entry = this.pending.get(msg.id)
        if (!entry) continue
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        if (msg.ok) {
          entry.resolve(msg.result)
        } else {
          const code = (msg.error?.code ?? 'BACKEND_FAILED') as ComputerUseError['code']
          entry.reject(new ComputerUseError(code, msg.error?.message ?? 'Worker error'))
        }
      }
    })

    child.once('exit', () => {
      this.rejectAll(new ComputerUseError('BACKEND_DISCONNECTED', 'Isolated browser worker exited unexpectedly'))
    })
  }

  private rejectAll(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(err)
    }
  }

  private call<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    const stdin = this.child?.stdin
    if (!this.child || this.closed || !stdin || !stdin.writable) {
      return Promise.reject(new ComputerUseError('BACKEND_DISCONNECTED', 'Isolated browser worker is not running'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ComputerUseError('EXECUTION_UNCERTAIN', `Isolated worker RPC "${method}" timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  probeCapabilities(): Promise<BrowserCapabilities> {
    return this.call<BrowserCapabilities>('probeCapabilities', {})
  }

  startFixtureServer(routes: Record<string, string>): Promise<{ baseUrl: string }> {
    return this.call<{ baseUrl: string }>('startFixtureServer', { routes })
  }

  inspectIsolation(canaryPath: string, hostPort: number): Promise<{
    canaryReadable: boolean
    hostReachable: boolean
    ns: { user: string; net: string; pid: string }
    home: string | null
    wayland: string | null
    display: string | null
    dbus: string | null
  }> {
    return this.call('inspectIsolation', { canaryPath, hostPort })
  }

  createSession(
    config: BrowserSessionConfig,
  ): Promise<{ sessionId: string; tempProfileDir: string; hasNoSandboxFlag: boolean }> {
    return this.call('createSession', config)
  }

  openTab(sessionId: string, ownerId: string, botId: string): Promise<BrowserTabInfo> {
    return this.call('openTab', { sessionId, ownerId, botId })
  }

  async observeTab(
    sessionId: string,
    ownerId: string,
    botId: string,
    tabId: string,
  ): Promise<BrowserObservation> {
    const raw = await this.call<Omit<BrowserObservation, 'buffer'> & { bufferBase64: string }>(
      'observeTab',
      { sessionId, ownerId, botId, tabId },
    )
    return {
      ...raw,
      buffer: new Uint8Array(Buffer.from(raw.bufferBase64, 'base64')),
    }
  }

  executeBatch(batch: BrowserActionBatch): Promise<BrowserBatchResult> {
    return this.call('executeBatch', batch)
  }

  cancelBatch(sessionId: string, batchId: string): Promise<{ ok: boolean }> {
    return this.call('cancelBatch', { sessionId, batchId })
  }

  closeSession(sessionId: string, ownerId: string): Promise<{ ok: boolean }> {
    return this.call('closeSession', { sessionId, ownerId })
  }

  async emergencyStop(): Promise<{ confirmed: boolean }> {
    if (this.closed) return { confirmed: true }
    this.closed = true
    this.rejectAll(new ComputerUseError('EMERGENCY_STOPPED', 'Isolated browser worker emergency-stopped'))

    let confirmed = true
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM')
      confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.child?.kill('SIGKILL')
          resolve(false)
        }, 2000)
        this.child!.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
    }
    if (this.workDir && fs.existsSync(this.workDir)) {
      fs.rmSync(this.workDir, { recursive: true, force: true })
    }
    this.child = null
    return { confirmed }
  }

  async close(): Promise<void> {
    if (!this.closed && this.child && this.child.exitCode === null) {
      await this.call('closeAll', {}, 5000).catch(() => {})
    }
    await this.emergencyStop()
  }
}
