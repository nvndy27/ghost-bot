import { lookup } from 'node:dns/promises'
import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import { BlockList, connect, isIP, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'

export type BrowserScope = { kind: 'local'; origin: string } | { kind: 'public' }

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix)

export function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4 || blocked.check(address)) return false
  const local = new BlockList()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4') continue
      if (!entry.cidr) {
        local.addAddress(entry.address)
        continue
      }
      const prefix = Number(entry.cidr.split('/')[1])
      local.addSubnet(entry.address, prefix)
    }
  }
  return !local.check(address)
}

export function parseBrowserUrl(raw: string): URL {
  if (!raw || raw.length > 2048) throw new Error('Enter an HTTP or HTTPS URL.')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS URLs without embedded credentials are supported.')
  }
  return url
}

export function browserScope(url: URL): BrowserScope {
  return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)
    ? { kind: 'local', origin: url.origin }
    : { kind: 'public' }
}

export function urlInScope(url: URL, scope: BrowserScope): boolean {
  if (scope.kind === 'local') return scope.origin === url.origin
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (browserScope(url).kind === 'local' || host.endsWith('.localhost') || !host.includes('.')) return false
  if (isIP(host)) return publicIpv4(host) && !url.port
  return !url.port && !host.includes(':')
}

const hop = ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'alt-svc']

function forwarded(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers }
  for (const key of [...hop, ...(headers.connection ?? '').toLowerCase().split(',').map((item) => item.trim())]) {
    delete result[key]
  }
  return result
}

export async function createBrowserProxy(scope: BrowserScope) {
  const clients = new Set<Duplex>()
  const upstream = new Set<Socket>()
  let resolving = 0
  let closed = false

  async function resolve(url: URL) {
    if (!urlInScope(url, scope) || closed) throw new Error('Outside browser scope')
    if (scope.kind === 'local') return url.hostname === '[::1]' ? '::1' : '127.0.0.1'
    if (isIP(url.hostname)) return url.hostname
    if (resolving >= 12) throw new Error('Resolver is busy')
    resolving += 1
    try {
      const answers = await lookup(url.hostname, { all: true, family: 4 })
      if (closed || !answers.length || answers.some(({ address }) => !publicIpv4(address))) throw new Error('Private destination')
      return answers[0].address
    } finally {
      resolving -= 1
    }
  }

  function watch(socket: Socket) {
    upstream.add(socket)
    socket.once('close', () => upstream.delete(socket))
    socket.setTimeout(15_000, () => socket.destroy())
    if (closed) socket.destroy()
  }

  const server = createServer({ maxHeaderSize: 32_768, headersTimeout: 5000, requestTimeout: 10_000 }, (incoming, response) => {
    void (async () => {
      try {
        if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
          response.writeHead(405).end()
          return
        }
        const url = parseBrowserUrl(incoming.url ?? '')
        if (url.protocol !== 'http:') throw new Error('Invalid proxy request')
        const address = await resolve(url)
        if (response.destroyed || upstream.size >= 16) throw new Error('Proxy is busy')
        const headers = forwarded(incoming.headers)
        delete headers['content-length']
        headers.host = url.host
        const outgoing = request({
          hostname: address, port: url.port || 80, method: incoming.method,
          path: url.pathname + url.search, headers, agent: false,
        }, (reply) => {
          response.writeHead(reply.statusCode ?? 502, forwarded(reply.headers))
          reply.pipe(response)
        })
        outgoing.on('socket', watch)
        outgoing.on('error', () => {
          if (!response.headersSent) response.writeHead(502).end()
          else response.destroy()
        })
        response.once('close', () => outgoing.destroy())
        outgoing.end()
      } catch {
        if (!response.headersSent && !response.destroyed) response.writeHead(403).end()
      }
    })()
  })
  server.maxConnections = 20
  server.on('connection', (socket) => {
    clients.add(socket)
    socket.setTimeout(15_000, () => socket.destroy())
    socket.once('close', () => clients.delete(socket))
  })
  server.on('upgrade', (_request, socket) => socket.destroy())
  server.on('connect', (incoming, socket, head) => {
    void (async () => {
      try {
        const authority = incoming.url ?? ''
        if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+):[0-9]{1,5}$/i.test(authority)) throw new Error('Invalid tunnel')
        const url = parseBrowserUrl(`https://${authority}`)
        const address = await resolve(url)
        if (socket.destroyed || upstream.size >= 16) throw new Error('Proxy is busy')
        const target = connect({ host: address, port: Number(url.port || '443') })
        watch(target)
        target.once('error', () => socket.destroy())
        socket.once('close', () => target.destroy())
        target.once('close', () => socket.destroy())
        target.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) target.write(head)
          socket.pipe(target).pipe(socket)
        })
      } catch {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Browser network isolation unavailable.')
  }
  return {
    port: address.port,
    close() {
      closed = true
      server.close()
      for (const socket of clients) socket.destroy()
      for (const socket of upstream) socket.destroy()
    },
  }
}
