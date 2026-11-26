import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
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

export interface BwrapWorkerOptions {
  workerScriptPath?: string
}

/**
 * Composed isolated browser worker:
 * Computer Use Controller -> BwrapIsolatedBrowserWorker -> bwrap (--unshare-all --cap-drop ALL) -> PlaywrightBrowserBackend (chromiumSandbox: true).
 * Never falls back to an unisolated host browser.
 */
export class BwrapIsolatedBrowserWorker {
  private readonly options: BwrapWorkerOptions
  private child: ChildProcess | null = null
  private workDir: string | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private buffer = ''
  private closed = false

  constructor(options: BwrapWorkerOptions = {}) {
    this.options = options
  }

  getPid(): number | null {
    return this.child?.pid ?? null
  }

  private resolveWorkerBindsAndEntry(): { binds: string[]; entryArg: string } {
    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const bundledCandidates = [
      this.options.workerScriptPath,
      process.env.GHOST_CU_WORKER_PATH,
      path.join(thisDir, 'computer-use-worker.mjs'),
    ].filter((p): p is string => Boolean(p))

    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) {
        const real = fs.realpathSync(candidate)
        return {
          binds: ['--ro-bind', path.dirname(real), '/cu-worker'],
          entryArg: `/cu-worker/${path.basename(real)}`,
        }
      }
    }

    // Development / workspace source execution
    const pkgDir = path.resolve(thisDir, '../..')
    const entryFile = path.join(pkgDir, 'src', 'browser', 'worker-entry.ts')
    if (!fs.existsSync(entryFile)) {
      throw new ComputerUseError(
        'BACKEND_FAILED',
        'Computer Use browser worker script not found in packaged or workspace layout',
      )
    }
    const req = createRequire(import.meta.url)
    let nmDir: string
    try {
      const pwPkg = req.resolve('playwright-core/package.json')
      nmDir = path.dirname(path.dirname(pwPkg))
    } catch {
      const fallbackNm = path.resolve(pkgDir, '../../node_modules')
      if (!fs.existsSync(fallbackNm)) {
        throw new ComputerUseError(
          'BACKEND_FAILED',
          'playwright-core node_modules directory not found for isolated worker',
        )
      }
      nmDir = fallbackNm
    }

    return {
      binds: ['--ro-bind', pkgDir, '/pkg', '--ro-bind', nmDir, '/nm'],
      entryArg: '/pkg/src/browser/worker-entry.ts',
    }
  }

  async start(): Promise<void> {
    if (this.child) return
    const { binds, entryArg } = this.resolveWorkerBindsAndEntry()

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
      ...binds,
      '--bind',
      this.workDir,
      '/work',
      '--chdir',
      '/work',
      '/usr/bin/node',
      entryArg,
    ]

    const bwrapPath = ['/usr/bin/bwrap', '/bin/bwrap'].find((p) => fs.existsSync(p))
    if (!bwrapPath) {
      fs.rmSync(this.workDir, { recursive: true, force: true })
      this.workDir = null
      throw new ComputerUseError(
        'BACKEND_FAILED',
        'Bubblewrap (bwrap) binary not available; isolated browser disabled without fallback',
      )
    }

    const child = spawn(bwrapPath, args, {
      env: { PATH: '/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    let stderrTail = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192)
    })

    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(this.buffer, 'utf8') + chunk.length > MAX_RPC_LINE_BYTES) {
        this.buffer = ''
        this.rejectAll(new ComputerUseError('BACKEND_FAILED', 'Isolated browser worker exceeded max RPC frame size'))
        void this.emergencyStop()
        return
      }
      this.buffer += chunk.toString('utf8')
      let idx = this.buffer.indexOf('\n')
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx)
        this.buffer = this.buffer.slice(idx + 1)
        idx = this.buffer.indexOf('\n')
        if (!line.trim()) continue
        let msg: RpcResponse
        try {
          msg = JSON.parse(line) as RpcResponse
        } catch {
          this.rejectAll(new ComputerUseError('BACKEND_FAILED', 'Isolated browser worker emitted malformed JSON'))
          void this.emergencyStop()
          return
        }
        if (
          !msg ||
          typeof msg !== 'object' ||
          typeof msg.id !== 'number' ||
          !Number.isInteger(msg.id) ||
          typeof msg.ok !== 'boolean'
        ) {
          continue
        }
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

    child.once('error', (err) => {
      this.rejectAll(
        new ComputerUseError(
          'BACKEND_DISCONNECTED',
          `Isolated browser worker process error: ${err.message}`,
        ),
      )
    })

    child.once('exit', () => {
      this.rejectAll(
        new ComputerUseError(
          'BACKEND_DISCONNECTED',
          stderrTail ? `Isolated browser worker exited (${stderrTail.slice(-200)})` : 'Isolated browser worker exited unexpectedly',
        ),
      )
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
