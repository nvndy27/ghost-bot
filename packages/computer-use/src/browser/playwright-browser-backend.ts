import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactAuditError } from '../audit/audit-log.ts'
import type {
  BrowserAction,
  BrowserActionBatch,
  BrowserActionLedgerEntry,
  BrowserBatchResult,
  BrowserCapabilities,
  BrowserObservation,
  BrowserSessionConfig,
  BrowserTabInfo,
} from '../contracts/browser.ts'
import { ComputerUseError } from '../contracts/types.ts'
import { MAX_TEXT_ENTRY_BYTES, MAX_WAIT_MS } from '../validation/actions.ts'
import { normalizeAllowedOrigins, validateBrowserUrl } from './network-policy.ts'

// Minimal structural types for playwright-core without requiring @types/playwright-core
interface PwRoute {
  request(): { url(): string; resourceType(): string; isNavigationRequest(): boolean }
  abort(errorCode?: string): Promise<void>
  continue(): Promise<void>
}
interface PwPage {
  url(): string
  title(): Promise<string>
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>
  screenshot(opts?: { type?: 'png'; fullPage?: boolean }): Promise<Buffer>
  innerText(selector: string): Promise<string>
  click(selector: string, opts?: { timeout?: number }): Promise<void>
  fill(selector: string, value: string, opts?: { timeout?: number }): Promise<void>
  mouse: {
    click(x: number, y: number): Promise<void>
    wheel(deltaX: number, deltaY: number): Promise<void>
  }
  keyboard: { press(key: string): Promise<void> }
  mainFrame(): unknown
  on(event: string, listener: (...args: unknown[]) => void): void
  close(): Promise<void>
}
interface PwContext {
  newPage(): Promise<PwPage>
  route(url: string, handler: (route: PwRoute) => Promise<void> | void): Promise<void>
  cookies(): Promise<unknown[]>
  close(): Promise<void>
}
interface PwBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PwContext>
  close(): Promise<void>
}
interface PwModule {
  chromium: {
    executablePath(): string
    launch(opts?: Record<string, unknown>): Promise<PwBrowser>
    launchPersistentContext?(userDataDir: string, opts?: Record<string, unknown>): Promise<PwContext>
  }
}

interface InternalTab {
  tabId: string
  page: PwPage
  navigationGeneration: number
}

interface InternalBrowserSession {
  sessionId: string
  config: BrowserSessionConfig
  allowedOrigins: Set<string>
  tempProfileDir: string
  browser: PwBrowser | null
  context: PwContext
  tabs: Map<string, InternalTab>
  activeTabId: string | null
  observations: Map<string, BrowserObservation>
  seenActionIds: Set<string>
  cancelledBatches: Set<string>
  ledger: BrowserActionLedgerEntry[]
  emergencyStopped: boolean
  closed: boolean
  viewport: { width: number; height: number }
}

const DEFAULT_SYSTEM_CHROME = '/usr/bin/google-chrome'
const ALLOWED_BROWSER_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
])

async function loadPlaywright(customPath?: string): Promise<PwModule> {
  const candidates = [customPath, 'playwright-core'].filter((p): p is string => Boolean(p))

  for (const candidate of candidates) {
    try {
      const mod = (await import(candidate)) as PwModule
      if (mod?.chromium) return mod
    } catch {
      // try next candidate
    }
  }
  throw new ComputerUseError(
    'BACKEND_FAILED',
    'playwright-core module could not be resolved',
  )
}

function resolveExecutablePath(pw: PwModule, explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new ComputerUseError('BACKEND_FAILED', `Browser executable not found at "${explicit}"`)
    }
    return explicit
  }
  try {
    const pwPath = pw.chromium.executablePath()
    if (pwPath && fs.existsSync(pwPath)) return pwPath
  } catch {
    // fallback
  }
  if (fs.existsSync(DEFAULT_SYSTEM_CHROME)) return DEFAULT_SYSTEM_CHROME
  throw new ComputerUseError('BACKEND_FAILED', 'No Chromium/Chrome executable found on host')
}

export class PlaywrightBrowserBackend {
  private readonly sessions = new Map<string, InternalBrowserSession>()
  private readonly sessionLocks = new Map<string, Promise<void>>()

  async probeCapabilities(options?: {
    executablePath?: string
    playwrightModulePath?: string
  }): Promise<BrowserCapabilities> {
    try {
      const pw = await loadPlaywright(options?.playwrightModulePath)
      const execPath = resolveExecutablePath(pw, options?.executablePath)
      return {
        engine: 'chromium',
        executablePath: execPath,
        sandboxed: true,
        headless: true,
        contextIsolation: true,
        temporaryProfileSupported: true,
        networkPolicyMode: 'allowlist',
        notes: [
          'Chromium sandbox enabled (no --no-sandbox).',
          'Uses per-session isolated BrowserContext and temporary 0700 profile directory.',
          'Network policy enforces origin allowlist at Playwright route level; OS-level network namespaces require separate container/daemon integration.',
        ],
      }
    } catch (err) {
      return {
        engine: 'chromium',
        executablePath: null,
        sandboxed: false,
        headless: true,
        contextIsolation: false,
        temporaryProfileSupported: false,
        networkPolicyMode: 'allowlist',
        notes: [err instanceof Error ? err.message : 'Browser capability probe failed'],
      }
    }
  }

  private getSession(sessionId: string, ownerId: string, botId?: string): InternalBrowserSession {
    const s = this.sessions.get(sessionId)
    if (!s || s.closed) {
      throw new ComputerUseError('SESSION_NOT_FOUND', `Browser session "${sessionId}" not found or closed`)
    }
    if (s.config.scope.ownerId !== ownerId || (botId !== undefined && s.config.scope.botId !== botId)) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Browser session access denied outside owner/bot scope')
    }
    if (s.emergencyStopped) {
      throw new ComputerUseError('EMERGENCY_STOPPED', 'Browser session was emergency-stopped')
    }
    return s
  }

  async createSession(config: BrowserSessionConfig): Promise<{ sessionId: string; tempProfileDir: string }> {
    const allowedOrigins = normalizeAllowedOrigins(config.scope.allowedOrigins)
    const pw = await loadPlaywright(config.playwrightModulePath)
    const executablePath = resolveExecutablePath(pw, config.executablePath)
    const sessionId = config.sessionId ?? `cu_brow_${randomUUID()}`
    const viewport = config.viewport ?? { width: 1280, height: 720 }
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-cu-browser-'))
    fs.chmodSync(tempProfileDir, 0o700)

    let browser: PwBrowser | null = null
    let context: PwContext | null = null
    const launchArgs = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]

    try {
      if (pw.chromium.launchPersistentContext) {
        context = await pw.chromium.launchPersistentContext(tempProfileDir, {
          executablePath,
          headless: config.headless ?? true,
          chromiumSandbox: true,
          args: launchArgs,
          viewport,
          acceptDownloads: false,
          permissions: [],
          serviceWorkers: 'block',
        })
      } else {
        browser = await pw.chromium.launch({
          executablePath,
          headless: config.headless ?? true,
          chromiumSandbox: true,
          args: launchArgs,
        })
        context = await browser.newContext({
          viewport,
          acceptDownloads: false,
          permissions: [],
          serviceWorkers: 'block',
        })
      }

      // Enforce origin allowlist across main frames, subframes, XHR/fetch, and WebSockets
      await context.route('**/*', async (route) => {
        const req = route.request()
        const url = req.url()
        if (url === 'about:blank') {
          await route.continue()
          return
        }
        try {
          validateBrowserUrl(url, allowedOrigins, { allowWebSocket: true })
          await route.continue()
        } catch {
          await route.abort('blockedbyclient')
        }
      })
    } catch (err) {
      if (context) await context.close().catch(() => {})
      if (browser) await browser.close().catch(() => {})
      if (fs.existsSync(tempProfileDir)) {
        fs.rmSync(tempProfileDir, { recursive: true, force: true })
      }
      throw err
    }

    const session: InternalBrowserSession = {
      sessionId,
      config,
      allowedOrigins,
      tempProfileDir,
      browser,
      context,
      tabs: new Map(),
      activeTabId: null,
      observations: new Map(),
      seenActionIds: new Set(),
      cancelledBatches: new Set(),
      ledger: [],
      emergencyStopped: false,
      closed: false,
      viewport,
    }
    this.sessions.set(sessionId, session)
    return { sessionId, tempProfileDir }
  }

  async openTab(sessionId: string, ownerId: string, botId: string): Promise<BrowserTabInfo> {
    const s = this.getSession(sessionId, ownerId, botId)
    if (s.tabs.size >= s.config.scope.maxTabs) {
      throw new ComputerUseError('INVALID_INPUT', `Tab limit (${s.config.scope.maxTabs}) reached`)
    }
    const page = await s.context.newPage()
    const tabId = `tab_${randomUUID()}`
    const tab: InternalTab = { tabId, page, navigationGeneration: 0 }

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        tab.navigationGeneration += 1
      }
    })
    page.on('popup', (popup) => {
      const p = popup as PwPage
      void p.close().catch(() => {})
    })
    page.on('download', (dl) => {
      const d = dl as { cancel?: () => Promise<void> }
      if (d.cancel) void d.cancel().catch(() => {})
    })

    s.tabs.set(tabId, tab)
    s.activeTabId = tabId
    return {
      tabId,
      url: page.url(),
      title: await page.title(),
      navigationGeneration: tab.navigationGeneration,
      active: true,
    }
  }

  async observeTab(
    sessionId: string,
    ownerId: string,
    botId: string,
    tabId: string,
  ): Promise<BrowserObservation> {
    const s = this.getSession(sessionId, ownerId, botId)
    if (!s.config.scope.allowObservation) {
      throw new ComputerUseError('CONSENT_REQUIRED', 'Browser observation is not authorized')
    }
    const tab = s.tabs.get(tabId)
    if (!tab) {
      throw new ComputerUseError('INVALID_INPUT', `Unknown tabId "${tabId}"`)
    }

    const buf = await tab.page.screenshot({ type: 'png', fullPage: false })
    const rawText = await tab.page.innerText('body').catch(() => '')
    const sanitizedSummary = (redactAuditError(rawText) ?? '').slice(0, 512)
    const observation: BrowserObservation = {
      observationId: `brow_obs_${randomUUID()}`,
      sessionId: s.sessionId,
      tabId: tab.tabId,
      url: tab.page.url(),
      navigationGeneration: tab.navigationGeneration,
      viewport: { ...s.viewport },
      mimeType: 'image/png',
      byteLength: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
      capturedAt: new Date().toISOString(),
      sanitizedSummary,
      isIsolatedBrowser: true,
      buffer: new Uint8Array(buf),
    }
    s.observations.set(observation.observationId, observation)
    return observation
  }

  cancelBatch(sessionId: string, batchId: string): void {
    const s = this.sessions.get(sessionId)
    if (s) s.cancelledBatches.add(batchId)
  }

  async executeBatch(batch: BrowserActionBatch): Promise<BrowserBatchResult> {
    const prev = this.sessionLocks.get(batch.sessionId) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.sessionLocks.set(batch.sessionId, prev.then(() => next))
    await prev
    try {
      return await this.executeBatchSerialized(batch)
    } finally {
      release()
    }
  }

  private async executeBatchSerialized(batch: BrowserActionBatch): Promise<BrowserBatchResult> {
    const s = this.getSession(batch.sessionId, batch.ownerId, batch.botId)
    if (batch.actions.length === 0 || batch.actions.length > s.config.scope.maxActionsPerBatch) {
      throw new ComputerUseError(
        'BATCH_TOO_LARGE',
        `Browser batch size must be 1..${s.config.scope.maxActionsPerBatch}`,
      )
    }
    for (const a of batch.actions) {
      if (s.seenActionIds.has(a.actionId)) {
        throw new ComputerUseError(
          'DUPLICATE_ACTION',
          `Duplicate browser actionId "${a.actionId}" rejected (no automatic replay)`,
        )
      }
    }

    const entries: BrowserActionLedgerEntry[] = []
    let halted = false
    let haltReason: string | null = null

    for (let i = 0; i < batch.actions.length; i += 1) {
      const action = batch.actions[i]!
      const tabId = action.kind === 'wait' ? null : action.tabId

      if (s.cancelledBatches.has(batch.batchId) || s.emergencyStopped || s.closed) {
        halted = true
        haltReason = s.emergencyStopped ? 'Emergency stopped' : 'Batch cancelled'
        const entry = this.makeLedgerEntry(s, tabId, action, 'cancelled', null, 0, false, 'BATCH_CANCELLED', haltReason)
        s.ledger.push(entry)
        entries.push(entry)
        continue
      }

      s.seenActionIds.add(action.actionId)
      const t0 = Date.now()
      try {
        const navGen = await this.executeSingleAction(s, action)
        const entry = this.makeLedgerEntry(
          s,
          tabId,
          action,
          'completed',
          navGen,
          Date.now() - t0,
          false,
          null,
          null,
        )
        s.ledger.push(entry)
        entries.push(entry)
      } catch (err) {
        const isScopeOrStale =
          err instanceof ComputerUseError &&
          (err.code === 'SCOPE_FORBIDDEN' ||
            err.code === 'CONSENT_REQUIRED' ||
            err.code === 'STALE_OBSERVATION' ||
            err.code === 'INVALID_ACTION' ||
            err.code === 'INVALID_INPUT')
        const status = isScopeOrStale ? 'failed' : 'uncertain'
        const code = err instanceof ComputerUseError ? err.code : 'EXECUTION_UNCERTAIN'
        const msg = err instanceof Error ? err.message : 'Browser action failed'
        const entry = this.makeLedgerEntry(
          s,
          tabId,
          action,
          status,
          null,
          Date.now() - t0,
          status === 'uncertain',
          code,
          msg,
        )
        s.ledger.push(entry)
        entries.push(entry)
        halted = true
        haltReason = msg

        for (let j = i + 1; j < batch.actions.length; j += 1) {
          const rem = batch.actions[j]!
          const remEntry = this.makeLedgerEntry(
            s,
            rem.kind === 'wait' ? null : rem.tabId,
            rem,
            'cancelled',
            null,
            0,
            false,
            'HALTED',
            'Halted after prior action error',
          )
          s.ledger.push(remEntry)
          entries.push(remEntry)
        }
        break
      }
    }

    return { batchId: batch.batchId, sessionId: s.sessionId, halted, haltReason, entries }
  }

  private async executeSingleAction(
    s: InternalBrowserSession,
    action: BrowserAction,
  ): Promise<number | null> {
    if (action.kind === 'wait') {
      if (!Number.isInteger(action.durationMs) || action.durationMs < 0 || action.durationMs > MAX_WAIT_MS) {
        throw new ComputerUseError('INVALID_ACTION', `wait.durationMs must be 0..${MAX_WAIT_MS}`)
      }
      await new Promise((r) => setTimeout(r, action.durationMs))
      return null
    }

    const tab = s.tabs.get(action.tabId)
    if (!tab) {
      throw new ComputerUseError('INVALID_INPUT', `Unknown tabId "${action.tabId}"`)
    }

    if (action.kind === 'navigate') {
      if (!s.config.scope.allowNavigation) {
        throw new ComputerUseError('CONSENT_REQUIRED', 'Browser navigation is not authorized')
      }
      const parsed = validateBrowserUrl(action.url, s.allowedOrigins)
      await tab.page.goto(parsed.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: s.config.timeoutMs ?? 10_000,
      })
      // Verify final URL after any server-side redirect is still in allowedOrigins
      validateBrowserUrl(tab.page.url(), s.allowedOrigins)
      return tab.navigationGeneration
    }

    if (!s.config.scope.allowInteraction) {
      throw new ComputerUseError('CONSENT_REQUIRED', 'Browser interaction is not authorized')
    }

    // Bind observation-dependent actions to session, tab, and navigationGeneration
    if (action.observationId !== undefined) {
      const obs = s.observations.get(action.observationId)
      if (!obs || obs.sessionId !== s.sessionId || obs.tabId !== tab.tabId) {
        throw new ComputerUseError('STALE_OBSERVATION', 'Observation does not match active session/tab')
      }
      if (obs.navigationGeneration !== tab.navigationGeneration) {
        throw new ComputerUseError('STALE_OBSERVATION', 'Observation navigationGeneration is stale')
      }
    }
    if (
      action.navigationGeneration !== undefined &&
      action.navigationGeneration !== tab.navigationGeneration
    ) {
      throw new ComputerUseError('STALE_OBSERVATION', 'Action navigationGeneration is stale')
    }

    const timeout = s.config.timeoutMs ?? 5_000
    switch (action.kind) {
      case 'click_selector':
        await tab.page.click(action.selector, { timeout })
        return tab.navigationGeneration
      case 'click_point':
        if (
          !Number.isFinite(action.x) ||
          !Number.isFinite(action.y) ||
          action.x < 0 ||
          action.y < 0 ||
          action.x >= s.viewport.width ||
          action.y >= s.viewport.height
        ) {
          throw new ComputerUseError('INVALID_COORDINATES', 'click_point outside viewport bounds')
        }
        await tab.page.mouse.click(action.x, action.y)
        return tab.navigationGeneration
      case 'type_text':
        if (Buffer.byteLength(action.text, 'utf8') > MAX_TEXT_ENTRY_BYTES) {
          throw new ComputerUseError('INVALID_ACTION', 'type_text exceeds max bytes')
        }
        await tab.page.fill(action.selector, action.text, { timeout })
        return tab.navigationGeneration
      case 'scroll':
        await tab.page.mouse.wheel(action.deltaX, action.deltaY)
        return tab.navigationGeneration
      case 'key_press':
        if (!ALLOWED_BROWSER_KEYS.has(action.key)) {
          throw new ComputerUseError('INVALID_ACTION', `Disallowed browser key "${action.key}"`)
        }
        await tab.page.keyboard.press(action.key)
        return tab.navigationGeneration
    }
  }

  private makeLedgerEntry(
    s: InternalBrowserSession,
    tabId: string | null,
    action: BrowserAction,
    status: BrowserActionLedgerEntry['status'],
    navigationGeneration: number | null,
    durationMs: number,
    uncertain: boolean,
    errorCode: string | null,
    errorMessage: string | null,
  ): BrowserActionLedgerEntry {
    return {
      entryId: `cu_bled_${randomUUID()}`,
      sessionId: s.sessionId,
      ownerId: s.config.scope.ownerId,
      botId: s.config.scope.botId,
      tabId,
      actionId: action.kind === 'wait' ? `wait_${randomUUID()}` : action.actionId,
      kind: action.kind,
      status,
      navigationGeneration,
      durationMs,
      uncertain,
      replayAllowed: false,
      errorCode,
      sanitizedError: redactAuditError(errorMessage),
      timestamp: new Date().toISOString(),
    }
  }

  getActionLedger(sessionId: string, ownerId: string): BrowserActionLedgerEntry[] {
    const s = this.sessions.get(sessionId)
    if (!s) throw new ComputerUseError('SESSION_NOT_FOUND', 'Browser session not found')
    if (s.config.scope.ownerId !== ownerId) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    }
    return s.ledger.map((e) => ({ ...e }))
  }

  async emergencyStop(sessionId: string, ownerId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.config.scope.ownerId !== ownerId) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    }
    s.emergencyStopped = true
    await this.closeSession(sessionId, ownerId)
  }

  async closeSession(sessionId: string, ownerId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) return
    if (s.config.scope.ownerId !== ownerId) {
      throw new ComputerUseError('SCOPE_FORBIDDEN', 'Owner mismatch')
    }
    if (s.closed) return
    s.closed = true
    try {
      await s.context.close()
    } catch {
      // ignore close errors during teardown
    }
    if (s.browser) {
      try {
        await s.browser.close()
      } catch {
        // ignore close errors during teardown
      }
    }
    if (fs.existsSync(s.tempProfileDir)) {
      fs.rmSync(s.tempProfileDir, { recursive: true, force: true })
    }
  }

  async closeAll(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      await this.closeSession(s.sessionId, s.config.scope.ownerId)
    }
  }
}
