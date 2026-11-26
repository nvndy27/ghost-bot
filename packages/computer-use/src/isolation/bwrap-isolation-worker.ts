import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ComputerUseError } from '../contracts/types.ts'

const execFileAsync = promisify(execFile)

export interface IsolationCapabilities {
  bubblewrapAvailable: boolean
  userNamespaceSupported: boolean
  networkNamespaceSupported: boolean
  hostWaylandExposed: false
  hostHomeExposed: false
  notes: string[]
}

export interface IsolatedWorkerRequest {
  script: string
  workspaceFiles?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  memoryLimitKb?: number
}

export interface IsolatedWorkerResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  workspaceCleaned: boolean
}

/**
 * Unprivileged OS-level isolation runner using bubblewrap (--unshare-all, --cap-drop ALL).
 * Never mounts $HOME, host credentials, host Wayland/X11 sockets, or Docker/Podman sockets.
 */
export class BubblewrapIsolationRunner {
  async probeCapabilities(): Promise<IsolationCapabilities> {
    try {
      await execFileAsync(
        'bwrap',
        [
          '--unshare-all',
          '--die-with-parent',
          '--new-session',
          '--cap-drop',
          'ALL',
          '--ro-bind',
          '/usr',
          '/usr',
          '--symlink',
          'usr/lib64',
          '/lib64',
          '--symlink',
          'usr/bin',
          '/bin',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '/bin/true',
        ],
        { timeout: 5000 },
      )
      return {
        bubblewrapAvailable: true,
        userNamespaceSupported: true,
        networkNamespaceSupported: true,
        hostWaylandExposed: false,
        hostHomeExposed: false,
        notes: [
          'bubblewrap --unshare-all (user, net, pid, ipc, uts) verified unprivileged.',
          'Host $HOME, Wayland/X11 sockets, DBus, and Podman/Docker sockets are not mounted.',
        ],
      }
    } catch (err) {
      return {
        bubblewrapAvailable: false,
        userNamespaceSupported: false,
        networkNamespaceSupported: false,
        hostWaylandExposed: false,
        hostHomeExposed: false,
        notes: [err instanceof Error ? err.message : 'bubblewrap unavailable'],
      }
    }
  }

  async runIsolatedNodeScript(req: IsolatedWorkerRequest): Promise<IsolatedWorkerResult> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-bwrap-work-'))
    fs.chmodSync(workDir, 0o700)

    const timeoutMs = Math.min(Math.max(100, req.timeoutMs ?? 10_000), 60_000)
    const maxOutputBytes = Math.min(Math.max(1024, req.maxOutputBytes ?? 256 * 1024), 1024 * 1024)
    const t0 = Date.now()

    try {
      if (req.workspaceFiles) {
        for (const [relPath, content] of Object.entries(req.workspaceFiles)) {
          const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '')
          if (!safeRel || path.isAbsolute(safeRel)) {
            throw new ComputerUseError('INVALID_INPUT', `Unsafe workspace relative path "${relPath}"`)
          }
          const full = path.join(workDir, safeRel)
          fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 })
          fs.writeFileSync(full, content, { mode: 0o600 })
        }
      }

      const args = [
        '--unshare-all',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--ro-bind',
        '/usr',
        '/usr',
        '--ro-bind',
        '/etc',
        '/etc',
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
        '--bind',
        workDir,
        '/work',
        '--chdir',
        '/work',
        '/usr/bin/node',
        '--input-type=module',
        '-e',
        req.script,
      ]

      const child = spawn('bwrap', args, {
        env: { PATH: '/usr/bin:/bin', HOME: '/work', TMPDIR: '/tmp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < maxOutputBytes) {
          stdout += chunk.toString('utf8').slice(0, maxOutputBytes - stdout.length)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < maxOutputBytes) {
          stderr += chunk.toString('utf8').slice(0, maxOutputBytes - stderr.length)
        }
      })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve) => {
          child.once('exit', (exitCode, exitSignal) => {
            clearTimeout(timer)
            resolve({ code: exitCode, signal: exitSignal })
          })
        },
      )

      return {
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - t0,
        workspaceCleaned: true,
      }
    } finally {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true })
      }
    }
  }
}
