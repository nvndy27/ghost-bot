import type { ActionOutcomeStatus } from './types.ts'

export interface VirtualDesktopCapabilities {
  backendKind: 'weston-headless' | 'xvfb' | 'podman-desktop'
  compositorAvailable: boolean
  isolatedSocketSupported: boolean
  frameCaptureSupported: boolean
  inputInjectionSupported: boolean
  hostDesktopIsolated: true
  notes: string[]
}

export interface VirtualDesktopSession {
  sessionId: string
  ownerId: string
  botId: string
  runtimeDir: string
  waylandSocket: string
  width: number
  height: number
  state: 'starting' | 'running' | 'stopped' | 'failed'
  startedAt: string
}

export interface VirtualDesktopBackend {
  probeCapabilities(): Promise<VirtualDesktopCapabilities>
  startSession(input: {
    ownerId: string
    botId: string
    width?: number
    height?: number
  }): Promise<VirtualDesktopSession>
  captureFrame(sessionId: string, ownerId: string): Promise<{ width: number; height: number; buffer: Uint8Array }>
  stopSession(sessionId: string, ownerId: string): Promise<{ confirmed: boolean }>
}

export type LiveViewerCaptureStatus = 'streaming' | 'paused' | 'stopped' | 'error'

export interface LiveViewerFrame {
  sessionId: string
  frameSeq: number
  timestamp: string
  width: number
  height: number
  mimeType: 'image/png' | 'image/raw'
  byteLength: number
  captureStatus: LiveViewerCaptureStatus
  backpressureDropCount: number
  stale: boolean
  executionStatus: ActionOutcomeStatus | 'idle'
  emergencyStopSignaled: boolean
}

export interface LiveViewerStreamContract {
  maxFrameBytes: number
  maxDeliveryFps: number
  persistScreenshotsByDefault: false
  subscribe(
    sessionId: string,
    ownerId: string,
    onFrame: (frame: LiveViewerFrame, payload: Uint8Array) => void,
  ): () => void
  signalEmergencyStop(sessionId: string, ownerId: string): Promise<void>
}
