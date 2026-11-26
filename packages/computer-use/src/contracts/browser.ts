import type { ActionOutcomeStatus } from './types.ts'

export interface BrowserCapabilities {
  engine: 'chromium'
  executablePath: string | null
  sandboxed: boolean
  headless: boolean
  contextIsolation: boolean
  temporaryProfileSupported: boolean
  networkPolicyMode: 'allowlist'
  notes: string[]
}

export interface BrowserPermissionScope {
  ownerId: string
  botId: string
  allowNavigation: boolean
  allowObservation: boolean
  allowInteraction: boolean
  allowedOrigins: string[]
  maxTabs: number
  maxActionsPerBatch: number
}

export interface BrowserSessionConfig {
  sessionId?: string
  scope: BrowserPermissionScope
  viewport?: { width: number; height: number }
  headless?: boolean
  executablePath?: string
  playwrightModulePath?: string
  timeoutMs?: number
}

export interface BrowserTabInfo {
  tabId: string
  url: string
  title: string
  navigationGeneration: number
  active: boolean
}

export interface BrowserObservation {
  observationId: string
  sessionId: string
  tabId: string
  url: string
  navigationGeneration: number
  viewport: { width: number; height: number }
  mimeType: 'image/png'
  byteLength: number
  sha256: string
  capturedAt: string
  /** Untrusted bounded summary of visible page text; never authorization. */
  sanitizedSummary: string
  isIsolatedBrowser: true
  buffer: Uint8Array
}

export type BrowserAction =
  | {
      actionId: string
      kind: 'navigate'
      tabId: string
      url: string
      description?: string
    }
  | {
      actionId: string
      kind: 'click_selector'
      tabId: string
      selector: string
      observationId?: string
      navigationGeneration?: number
      description?: string
    }
  | {
      actionId: string
      kind: 'click_point'
      tabId: string
      x: number
      y: number
      observationId?: string
      navigationGeneration?: number
      description?: string
    }
  | {
      actionId: string
      kind: 'type_text'
      tabId: string
      selector: string
      text: string
      observationId?: string
      navigationGeneration?: number
      description?: string
    }
  | {
      actionId: string
      kind: 'scroll'
      tabId: string
      deltaX: number
      deltaY: number
      observationId?: string
      navigationGeneration?: number
      description?: string
    }
  | {
      actionId: string
      kind: 'key_press'
      tabId: string
      key: string
      observationId?: string
      navigationGeneration?: number
      description?: string
    }
  | {
      actionId: string
      kind: 'wait'
      durationMs: number
      description?: string
    }

export interface BrowserActionBatch {
  batchId: string
  sessionId: string
  ownerId: string
  botId: string
  actions: BrowserAction[]
}

export interface BrowserActionLedgerEntry {
  entryId: string
  sessionId: string
  ownerId: string
  botId: string
  tabId: string | null
  actionId: string
  kind: BrowserAction['kind']
  status: ActionOutcomeStatus
  navigationGeneration: number | null
  durationMs: number
  uncertain: boolean
  replayAllowed: false
  errorCode: string | null
  sanitizedError: string | null
  timestamp: string
}

export interface BrowserBatchResult {
  batchId: string
  sessionId: string
  halted: boolean
  haltReason: string | null
  entries: BrowserActionLedgerEntry[]
}
