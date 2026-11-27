import { randomUUID } from 'node:crypto'
import { session, WebContentsView, type BrowserWindow, type Session } from 'electron'
import type { WorkspaceBrowserBounds, WorkspaceBrowserCommand, WorkspaceBrowserState } from '@ghost-bot/shared-types/ipc'
import { browserScope, createBrowserProxy, parseBrowserUrl, urlInScope, type BrowserScope } from './network.js'

type Tab = WorkspaceBrowserState['tabs'][number] & {
  view?: WebContentsView
  proxy?: Awaited<ReturnType<typeof createBrowserProxy>>
  partition?: Session
  scope?: BrowserScope
  timer?: NodeJS.Timeout
  redirects: number
  nextConsoleAt: number
  epoch: number
}

const screenshotLimit = 1024 * 1024
const eventName = 'ghost:workspace:browser-state'

function sameScope(left: BrowserScope | undefined, right: BrowserScope): boolean {
  if (!left || left.kind !== right.kind) return false
  return left.kind === 'public' || (right.kind === 'local' && left.origin === right.origin)
}

export class WorkspaceBrowserController {
  private readonly window: BrowserWindow
  private readonly tabs = new Map<string, Tab>()
  private active: string | null = null
  private bounds: WorkspaceBrowserBounds = null
  private lastScreenshot = 0
  private allocatedSessions = 0

  constructor(window: BrowserWindow) {
    this.window = window
    window.on('resize', () => this.layout())
    window.on('hide', () => this.layout())
    window.on('show', () => this.layout())
    window.on('minimize', () => this.layout())
    window.on('restore', () => this.layout())
    window.once('closed', () => this.closeAll())
  }

  state(): WorkspaceBrowserState {
    return {
      active: this.active,
      tabs: [...this.tabs.values()].map(({ id, url, title, loading, error, back, forward, preset, console }) =>
        ({ id, url, title, loading, error, back, forward, preset, console: [...console] })),
    }
  }

  private emit() {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(eventName, this.state())
    }
  }

  private clearTimer(tab: Tab) {
    if (tab.timer) clearTimeout(tab.timer)
    tab.timer = undefined
  }

  private detach(tab: Tab) {
    this.clearTimer(tab)
    const view = tab.view
    tab.view = undefined
    tab.proxy?.close()
    tab.proxy = undefined
    const partition = tab.partition
    tab.partition = undefined
    tab.scope = undefined
    if (view) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    }
    if (partition) {
      void partition.closeAllConnections().catch(() => {})
      void partition.clearStorageData().catch(() => {})
      void partition.clearCache().catch(() => {})
    }
  }

  closeAll() {
    for (const tab of this.tabs.values()) {
      tab.epoch += 1
      this.detach(tab)
    }
    this.tabs.clear()
    this.active = null
    this.bounds = null
    this.emit()
  }

  setBounds(bounds: WorkspaceBrowserBounds) {
    this.bounds = bounds
    this.layout()
  }

  private layout() {
    if (this.window.isDestroyed()) return
    const [width, height] = this.window.getContentSize()
    for (const tab of this.tabs.values()) {
      if (!tab.view) continue
      const bound = this.bounds
      const visible = Boolean(
        bound && this.active === tab.id && this.window.isVisible() && !this.window.isMinimized() &&
        bound.y >= 40 && bound.y < height && bound.x < width,
      )
      if (bound && visible) {
        const availableWidth = Math.min(bound.width, width - bound.x)
        const viewportWidth = tab.preset === 'mobile' ? Math.min(390, availableWidth) : availableWidth
        tab.view.setBounds({
          x: bound.x + Math.floor((availableWidth - viewportWidth) / 2), y: bound.y,
          width: viewportWidth, height: Math.min(bound.height, height - bound.y),
        })
      }
      tab.view.setVisible(visible)
    }
  }

  private install(tab: Tab, view: WebContentsView, scope: BrowserScope) {
    const web = view.webContents
    const current = () => tab.view === view && this.tabs.has(tab.id)
    const allowed = (raw: string) => {
      try { return urlInScope(parseBrowserUrl(raw), scope) } catch { return false }
    }
    web.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    if (web.getWebRTCIPHandlingPolicy() !== 'disable_non_proxied_udp') throw new Error('Browser network isolation unavailable.')
    web.setWindowOpenHandler(() => ({ action: 'deny' }))
    web.on('will-attach-webview', (event) => event.preventDefault())
    web.on('login', (event) => event.preventDefault())
    web.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback('') })

    const partition = web.session
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.setDevicePermissionHandler(() => false)
    partition.setDisplayMediaRequestHandler((_request, callback) => callback({}))
    partition.on('will-download', (event) => event.preventDefault())
    partition.webRequest.onBeforeRequest((details, callback) => {
      const localMethod = scope.kind !== 'local' || details.method === 'GET' || details.method === 'HEAD'
      callback({ cancel: !allowed(details.url) || !localMethod })
    })

    const fail = (message: string) => {
      if (!current()) return
      this.clearTimer(tab)
      tab.error = message
      tab.loading = false
      this.emit()
    }
    const block = (event: { url: string; isMainFrame: boolean; preventDefault: () => void }) => {
      if (allowed(event.url)) return
      event.preventDefault()
      if (event.isMainFrame) fail('Navigation was blocked by the browser isolation policy.')
    }
    web.on('will-frame-navigate', block)
    web.on('will-navigate', block)
    web.on('will-redirect', (event) => {
      if (event.isMainFrame && ++tab.redirects > 8) {
        event.preventDefault()
        fail('Navigation exceeded the redirect limit.')
      } else block(event)
    })
    web.on('did-start-navigation', (event) => {
      if (!current() || !event.isMainFrame || event.isSameDocument) return
      tab.redirects = 0
      tab.loading = true
      tab.error = null
      this.clearTimer(tab)
      tab.timer = setTimeout(() => {
        fail('Navigation timed out.')
        if (!web.isDestroyed()) web.stop()
      }, 12_000)
      this.emit()
    })
    const updateLocation = () => {
      if (!current()) return
      const url = web.getURL()
      if (allowed(url)) tab.url = url.slice(0, 2048)
      tab.back = web.navigationHistory.canGoBack()
      tab.forward = web.navigationHistory.canGoForward()
      this.emit()
    }
    web.on('did-navigate', updateLocation)
    web.on('did-navigate-in-page', updateLocation)
    web.on('did-stop-loading', () => {
      if (!current()) return
      this.clearTimer(tab)
      tab.loading = false
      updateLocation()
    })
    web.on('did-fail-load', (_event, code, _description, _url, main) => {
      if (main && code !== -3) fail('The page could not be loaded in the isolated browser.')
    })
    web.on('render-process-gone', () => fail('The browser page closed unexpectedly.'))
    web.on('page-title-updated', (_event, title) => {
      if (!current()) return
      tab.title = title.slice(0, 120)
      this.emit()
    })
    web.on('console-message', (event) => {
      if (!current()) return
      const time = Date.now()
      if (time < tab.nextConsoleAt) return
      tab.nextConsoleAt = time + 250
      // Arbitrary console strings can include credentials in any format. Keep severity only.
      tab.console = [...tab.console, { level: event.level, time }].slice(-40)
      this.emit()
    })
  }

  private async navigate(tab: Tab, raw: string) {
    let url: URL
    let scope: BrowserScope
    try {
      url = parseBrowserUrl(raw)
      scope = browserScope(url)
      if (!urlInScope(url, scope)) throw new Error('Unsupported browser destination.')
      if (scope.kind === 'local' && url.protocol !== 'http:') throw new Error('Local previews require HTTP.')
    } catch (err) {
      tab.error = err instanceof Error ? err.message : 'Invalid browser destination.'
      return
    }

    const epoch = ++tab.epoch
    if (!sameScope(tab.scope, scope)) {
      this.detach(tab)
      tab.loading = true
      tab.error = null
      tab.back = false
      tab.forward = false
      tab.title = ''
      tab.console = []
      this.emit()
      if (this.allocatedSessions >= 32) {
        tab.error = 'Browser session limit reached. Restart Ghost Bot to open another session.'
        tab.loading = false
        return
      }
      try {
        const proxy = await createBrowserProxy(scope)
        if (tab.epoch !== epoch || !this.tabs.has(tab.id) || this.window.isDestroyed()) { proxy.close(); return }
        tab.proxy = proxy
        this.allocatedSessions += 1
        const partition = session.fromPartition(`ghost-workspace-browser-${randomUUID()}`, { cache: false })
        tab.partition = partition
        await partition.setProxy({
          mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>',
        })
        if (tab.epoch !== epoch || !this.tabs.has(tab.id) || this.window.isDestroyed()) return
        const proxyRoute = await partition.resolveProxy(url.href)
        if (tab.epoch !== epoch || !this.tabs.has(tab.id) || this.window.isDestroyed()) return
        if (proxyRoute !== `PROXY 127.0.0.1:${proxy.port}`) throw new Error('Browser proxy unavailable.')
        const view = new WebContentsView({ webPreferences: {
          session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
          webSecurity: true, webviewTag: false, devTools: false, spellcheck: false,
        } })
        tab.scope = scope
        tab.view = view
        this.install(tab, view, scope)
        view.setVisible(false)
        this.window.contentView.addChildView(view)
        this.layout()
      } catch {
        if (tab.epoch === epoch) {
          this.detach(tab)
          tab.error = 'Browser network isolation is unavailable.'
          tab.loading = false
        }
        return
      }
    }
    if (!tab.view) return
    tab.url = url.href
    tab.error = null
    tab.view.webContents.stop()
    void tab.view.webContents.loadURL(url.href).catch((err: unknown) => {
      if (tab.epoch !== epoch || !this.tabs.has(tab.id) || String(err).includes('ERR_ABORTED')) return
      tab.error = 'The page could not be loaded in the isolated browser.'
      tab.loading = false
      this.emit()
    })
  }

  async command(command: WorkspaceBrowserCommand) {
    if (command.kind === 'new') {
      if (this.tabs.size >= 4) throw new Error('Close a tab before opening another.')
      const tab: Tab = {
        id: randomUUID(), url: '', title: '', loading: false, back: false, forward: false,
        error: null, preset: 'desktop', console: [], redirects: 0, nextConsoleAt: 0, epoch: 0,
      }
      this.tabs.set(tab.id, tab)
      this.active = tab.id
    } else if (command.kind === 'close-all') {
      this.closeAll()
    } else if (command.kind !== 'state') {
      const tab = this.tabs.get(command.tabId)
      if (!tab) throw new Error('Browser tab is no longer available.')
      const web = tab.view?.webContents
      switch (command.kind) {
        case 'select': this.active = tab.id; break
        case 'close':
          tab.epoch += 1
          this.detach(tab)
          this.tabs.delete(tab.id)
          if (this.active === tab.id) this.active = this.tabs.keys().next().value ?? null
          break
        case 'navigate': await this.navigate(tab, command.url); break
        case 'viewport': tab.preset = command.preset; break
        case 'back': if (web?.navigationHistory.canGoBack()) web.navigationHistory.goBack(); break
        case 'forward': if (web?.navigationHistory.canGoForward()) web.navigationHistory.goForward(); break
        case 'reload': web?.reload(); break
        case 'stop':
          if (!web && tab.loading) { tab.epoch += 1; this.detach(tab) }
          web?.stop()
          this.clearTimer(tab)
          tab.loading = false
          break
      }
    }
    this.layout()
    if (command.kind !== 'state') this.emit()
    return this.state()
  }

  async screenshot(id: string) {
    const view = this.tabs.get(id)?.view
    if (!view || id !== this.active || !this.bounds || !view.getVisible()) throw new Error('Open a visible page before taking a screenshot.')
    if (Date.now() - this.lastScreenshot < 750) throw new Error('Wait before taking another screenshot.')
    this.lastScreenshot = Date.now()
    const { width, height } = view.getBounds()
    if (width < 1 || height < 1 || width > 1600 || height > 1200) {
      throw new Error('Screenshot exceeds the preview dimensions.')
    }
    let image = await view.webContents.capturePage({ x: 0, y: 0, width, height })
    const size = image.getSize()
    if (size.width > 1600 || size.height > 1200) {
      image = image.resize({ width, height })
    }
    const bytes = image.toJPEG(70)
    if (bytes.length === 0 || bytes.length > screenshotLimit) throw new Error('Screenshot exceeds the preview size limit.')
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  }
}
