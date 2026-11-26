import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ComputerUseError } from '../contracts/types.ts'
import type {
  VirtualDesktopBackend,
  VirtualDesktopCapabilities,
  VirtualDesktopSession,
} from '../contracts/virtual-desktop.ts'

const execFileAsync = promisify(execFile)

interface InternalWestonSession {
  session: VirtualDesktopSession
  process: ChildProcess
}

/**
 * Headless Weston proof-of-concept backend.
 * Starts an isolated Wayland compositor socket in a private 0700 XDG_RUNTIME_DIR,
 * never touching the user's active GNOME/Hyprland WAYLAND_DISPLAY.
 * Frame capture and input injection remain gated until a VNC/PipeWire consumer is wired.
 */
export class WestonHeadlessVirtualDesktop implements VirtualDesktopBackend {
  private readonly sessions = new Map<string, InternalWestonSession>()

  async probeCapabilities(): Promise<VirtualDesktopCapabilities> {
    try {
      await execFileAsync('weston', ['--version'], { timeout: 3000 })
      const headlessModuleExists = fs.existsSync('/usr/lib64/libweston-15/headless-backend.so')
      return {
        backendKind: 'weston-headless',
        compositorAvailable: headlessModuleExists,
        isolatedSocketSupported: headlessModuleExists,
        frameCaptureSupported: false,
        inputInjectionSupported: false,
        hostDesktopIsolated: true,
        notes: [
          'Weston headless-backend.so is installed and starts an isolated Wayland socket in a private XDG_RUNTIME_DIR.',
          'Frame capture via grim is unsupported (Weston lacks wlr-screencopy-unstable-v1); VNC/PipeWire backend integration is required for live streaming and input.',
        ],
      }
    } catch {
      return {
        backendKind: 'weston-headless',
        compositorAvailable: false,
        isolatedSocketSupported: false,
        frameCaptureSupported: false,
        inputInjectionSupported: false,
        hostDesktopIsolated: true,
        notes: ['Weston binary is unavailable on host.'],
      }
    }
  }

  async startSession(input: {
    ownerId: string
    botId: string
    width?: number
    height?: number
  }): Promise<VirtualDesktopSession> {
    const width = Math.min(Math.max(320, input.width ?? 1280), 3840)
    const height = Math.min(Math.max(240, input.height ?? 720), 2160)
    const sessionId = `cu_vd_${randomUUID()}`
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-vd-rt-'))
    fs.chmodSync(runtimeDir, 0o700)
    const waylandSocket = `ghost-vd-${sessionId.slice(-8)}`

    const child = spawn(
      'weston',
      ['--backend=headless', `--socket=${waylandSocket}`, `--width=${width}`, `--height=${height}`],
      {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', XDG_RUNTIME_DIR: runtimeDir },
        stdio: 'ignore',
      },
    )

    const socketPath = path.join(runtimeDir, waylandSocket)
    let ready = false
    for (let i = 0; i < 20; i += 1) {
      if (fs.existsSync(socketPath)) {
        ready = true
        break
      }
      if (child.exitCode !== null) break
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!ready) {
      child.kill('SIGKILL')
      fs.rmSync(runtimeDir, { recursive: true, force: true })
      throw new ComputerUseError('BACKEND_FAILED', 'Weston headless failed to create isolated socket')
    }

    const session: VirtualDesktopSession = {
      sessionId,
      ownerId: input.ownerId,
      botId: input.botId,
      runtimeDir,
      waylandSocket,
      width,
      height,
      state: 'running',
      startedAt: new Date().toISOString(),
    }
    this.sessions.set(sessionId, { session, process: child })
    return { ...session }
  }

  async captureFrame(sessionId: string, ownerId: string): Promise<{ width: number; height: number; buffer: Uint8Array }> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new ComputerUseError('SESSION_NOT_FOUND', 'Virtual desktop session not found')
    if (entry.session.ownerId !== ownerId) throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    throw new ComputerUseError(
      'UNSUPPORTED_CAPABILITY',
      'Weston headless frame capture requires VNC/PipeWire consumer integration',
    )
  }

  async stopSession(sessionId: string, ownerId: string): Promise<{ confirmed: boolean }> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return { confirmed: true }
    if (entry.session.ownerId !== ownerId) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    }

    let confirmed = false
    if (entry.process.exitCode === null) {
      entry.process.kill('SIGTERM')
      confirmed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          entry.process.kill('SIGKILL')
          resolve(false)
        }, 2000)
        entry.process.once('exit', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
    } else {
      confirmed = true
    }

    entry.session.state = 'stopped'
    if (fs.existsSync(entry.session.runtimeDir)) {
      fs.rmSync(entry.session.runtimeDir, { recursive: true, force: true })
    }
    this.sessions.delete(sessionId)
    return { confirmed }
  }
}
