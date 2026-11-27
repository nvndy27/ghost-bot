import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeDaemonError, redactSecrets } from '../apps/daemon/src/errors.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import { resolveCodexVerifiedEvidence } from '../apps/daemon/src/runtime/policy-broker.ts'
import {
  isAllowedNavigationUrl,
  isAuthorizedIpcContext,
  validateLoopbackDevUrl,
} from '../apps/desktop/electron/security.ts'
import {
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  ProviderSummarySchema,
  WorkspaceContextIpcResponseSchema,
  WorkspaceSearchResultSchema,
  WorkspacePreviewResultSchema,
} from '../packages/shared-types/ipc.ts'

function requestSocket(
  socketPath: string,
  path: string,
  token?: string,
  payload?: unknown,
  method = payload === undefined ? 'GET' : 'POST',
): Promise<{ status: number; body: unknown }> {
  const encoded = payload === undefined ? undefined : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(encoded === undefined ? {} : {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(encoded),
          }),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          })
        })
      },
    )
    req.on('error', reject)
    req.end(encoded)
  })
}

test('daemon rejects weak authToken and unauthenticated requests', async () => {
  assert.throws(() => new GhostBotDaemon({ authToken: 'short' }), /INVALID_CONFIG|authToken/i)

  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-daemon-test-'))
  const socketPath = join(dir, 'daemon.sock')
  const dataDir = join(dir, 'data')
  const token = '0123456789abcdef0123456789abcdef'
  const daemon = new GhostBotDaemon({ authToken: token, socketPath, dataDir, runtimeMode: 'mock' })
  await daemon.start()

  try {
    const unauth = await requestSocket(socketPath, '/health')
    assert.equal(unauth.status, 401)

    const badToken = await requestSocket(socketPath, '/health', 'wrong-token-value-1234567890')
    assert.equal(badToken.status, 401)

    const health = await requestSocket(socketPath, '/health', token)
    assert.equal(health.status, 200)
    const parsedHealth = DaemonHealthResponseSchema.parse(health.body)
    assert.equal(parsedHealth.ok, true)
    assert.equal(parsedHealth.runtimeMode, 'mock')

    const providers = await requestSocket(socketPath, '/providers', token)
    assert.equal(providers.status, 200)
    assert.ok(Array.isArray(providers.body))
    const first = ProviderSummarySchema.parse(providers.body[0])
    assert.equal(first.status, 'mock')

    const grant = { botId: 'bot-fixture', workspaceId: 'fixture', selectedRoot: dir }
    assert.equal((await requestSocket(socketPath, '/workspace/authorize-read', undefined, grant)).status, 401)
    assert.equal((await requestSocket(socketPath, '/workspace/authorize-read', token, grant)).status, 403)
    assert.equal((await requestSocket(socketPath, '/workspace/context', token, { ...grant, canWrite: true })).status, 400)
    assert.equal((await requestSocket(socketPath, '/workspace/save', token, {})).status, 400)
    assert.equal((await requestSocket(socketPath, '/workspace/save', token, {
      botId: 'bot-fixture', workspaceId: 'fixture', authGeneration: 'unknown',
      relativePath: 'notes.txt', content: 'draft', expectedRevision: 'fixture',
    })).status, 403)

    const notFound = await requestSocket(socketPath, '/unknown', token)
    assert.equal(notFound.status, 404)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('workspace discovery routes require and revalidate the native personal grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-discovery-ipc-'))
  const socket = join(root, 'daemon.sock')
  const token = randomUUID()
  const daemon = new GhostBotDaemon({ authToken: token, socketPath: socket, dataDir: join(root, 'data'), runtimeMode: 'mock' })
  try {
    await daemon.start()
    await writeFile(join(root, 'notes.md'), '# Searchable fixture')
    const request = (route: string, payload: unknown, method = 'POST') => requestSocket(socket, route, token, payload, method)
    assert.equal((await request('/bots/chief', { workspacePath: root }, 'PATCH')).status, 200)
    const contextReply = await request('/workspace/context', { botId: 'chief' })
    const context = WorkspaceContextIpcResponseSchema.parse(contextReply.body)
    assert.ok(context.workspaceId)
    const scope = { botId: 'chief', workspaceId: context.workspaceId }
    const beforeConsent = { ...scope, authGeneration: 'unknown', operationId: randomUUID() }
    assert.equal((await request('/workspace/search', { ...beforeConsent, mode: 'content', query: 'Searchable' })).status, 403)
    assert.equal((await request('/workspace/authorize-read', { ...scope, selectedRoot: root })).status, 200)
    const authorized = WorkspaceContextIpcResponseSchema.parse((await request('/workspace/context', { botId: 'chief' })).body)
    assert.ok(authorized.authGeneration)
    const input = { ...scope, authGeneration: authorized.authGeneration, operationId: randomUUID() }
    const search = await request('/workspace/search', { ...input, mode: 'content', query: 'Searchable' })
    assert.equal(search.status, 200)
    assert.equal(WorkspaceSearchResultSchema.parse(search.body).results[0]?.relativePath, 'notes.md')
    const preview = await request('/workspace/preview', { ...input, relativePath: 'notes.md' })
    assert.equal(preview.status, 200)
    assert.equal(WorkspacePreviewResultSchema.parse(preview.body).preview.kind, 'markdown')
    assert.equal((await request('/workspace/cancel-discovery', input)).body, false)
    assert.equal((await request('/workspace/search', { ...input, teamId: 'team-fixture', mode: 'content', query: 'Searchable' })).status, 400)
    assert.equal((await request('/bots/chief', { permission: 'read-only' }, 'PATCH')).status, 200)
    assert.equal((await request('/workspace/cancel-discovery', input)).status, 403)
    assert.equal((await request('/workspace/preview', { ...input, relativePath: 'notes.md' })).status, 403)
  } finally {
    await daemon.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('Git mutation admission is gated independently of native Files grants and preserves external state', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'ghost-git-mutation-gate-'))
  const root = join(fixture, 'repository')
  const socket = join(fixture, 'daemon.sock')
  const token = randomUUID()
  const daemon = new GhostBotDaemon({ authToken: token, socketPath: socket, dataDir: join(fixture, 'data'), runtimeMode: 'mock' })
  try {
    await mkdir(root)
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, {
      cwd: root, env: { PATH: '/usr/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      stdio: 'ignore',
    })
    git('init')
    await writeFile(join(root, 'selected.txt'), 'external staged content')
    await writeFile(join(root, 'unrelated.txt'), 'unrelated bytes')
    git('add', '--', 'selected.txt')
    await writeFile(join(root, 'selected.txt'), 'external draft')
    // Represent an independent Git process holding its own lock during an interrupted update.
    const indexPath = join(root, '.git', 'index')
    const indexLockPath = join(root, '.git', 'index.lock')
    const index = await readFile(indexPath)
    await writeFile(indexLockPath, 'external pending index', { flag: 'wx' })
    const request = (path: string, payload: unknown, method = 'POST') => requestSocket(socket, path, token, payload, method)
    await daemon.start()
    assert.equal((await request('/bots/chief', { workspacePath: root, permission: 'workspace' }, 'PATCH')).status, 200)
    const selector = { botId: 'chief' }
    const initial = WorkspaceContextIpcResponseSchema.parse((await request('/workspace/context', selector)).body)
    const workspaceId = initial.workspaceId
    assert.ok(workspaceId)

    const denied = async (scope: { botId: string; workspaceId: string; authGeneration: string }) => {
      for (const action of ['stage', 'unstage', 'revert']) {
        const payload = { ...scope, action, paths: ['selected.txt'], operationId: randomUUID() }
        for (const route of ['/workspace/git/authorize-mutation', '/workspace/git/mutate']) {
          const result = await request(route, payload)
          assert.equal(result.status, 501)
          assert.equal((result.body as { code?: string }).code, 'GIT_MUTATIONS_GATED')
        }
      }
    }
    const pending = { ...selector, workspaceId, authGeneration: 'ungranted' }
    assert.equal((await requestSocket(socket, '/workspace/git/mutate', undefined, pending)).status, 401)
    await denied(pending)

    assert.equal((await request('/workspace/authorize-read', { ...selector, workspaceId, selectedRoot: root })).status, 200)
    const read = WorkspaceContextIpcResponseSchema.parse((await request('/workspace/context', selector)).body)
    assert.ok(read.authGeneration)
    const scope = { ...selector, workspaceId, authGeneration: read.authGeneration }
    await denied(scope)
    assert.equal((await request('/workspace/authorize-write', scope)).status, 200)
    await denied(scope)
    assert.equal((await request('/workspace/revoke-write', selector)).status, 200)
    await denied(scope)

    assert.deepEqual(await readFile(indexPath), index)
    assert.equal(await readFile(indexLockPath, 'utf8'), 'external pending index')
    assert.equal(await readFile(join(root, 'selected.txt'), 'utf8'), 'external draft')
    assert.equal(await readFile(join(root, 'unrelated.txt'), 'utf8'), 'unrelated bytes')
  } finally {
    await daemon.stop()
    await rm(fixture, { recursive: true, force: true })
  }
})

test('daemon error normalizer redacts secrets and IPC schemas reject unexpected params', () => {
  const redacted = redactSecrets('failed with Bearer abcdefghijklmnop and sk-1234567890abcdefghij')
  assert.equal(redacted.includes('abcdefghijklmnop'), false)
  assert.equal(redacted.includes('sk-1234567890'), false)

  const normalized = normalizeDaemonError(new Error('token sk-1234567890abcdefghij leaked'))
  assert.equal(normalized.statusCode, 500)
  assert.equal(normalized.body.message.includes('sk-1234567890'), false)

  assert.throws(() => EmptyParamsSchema.parse({ extra: 'not-allowed' }))
})

test('daemon enforces 0600 socket permissions and binds permission evidence to verified Codex version', async () => {
  assert.equal(resolveCodexVerifiedEvidence(null), null)
  assert.equal(resolveCodexVerifiedEvidence('0.171.9'), null)
  const ev = resolveCodexVerifiedEvidence('0.172.0')
  assert.ok(ev?.verifiedModes.includes('workspace'))
  assert.equal(ev?.verifiedModes.includes('full-access'), false)

  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-sock-perm-'))
  const socketPath = join(dir, 'daemon.sock')
  const dataDir = join(dir, 'data')
  const daemon = new GhostBotDaemon({
    authToken: '0123456789abcdef0123456789abcdef',
    socketPath,
    dataDir,
    runtimeMode: 'mock',
  })
  await daemon.start()
  try {
    const st = await stat(socketPath)
    assert.equal(st.mode & 0o777, 0o600)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Electron security helpers enforce exact loopback dev origin, exact navigation, and IPC sender identity', () => {
  assert.equal(validateLoopbackDevUrl('http://127.0.0.1:5173/app'), 'http://127.0.0.1:5173')
  assert.throws(() => validateLoopbackDevUrl('https://127.0.0.1:5173'))
  assert.throws(() => validateLoopbackDevUrl('http://127.0.0.1.evil.test:5173'))

  const distUrl = 'file:///app/dist/index.html'
  assert.equal(isAllowedNavigationUrl(distUrl, '', distUrl), true)
  assert.equal(isAllowedNavigationUrl(`${distUrl}.evil.html`, '', distUrl), false)
  assert.equal(isAllowedNavigationUrl('https://example.com', '', distUrl), false)
  assert.equal(isAllowedNavigationUrl('http://127.0.0.1:5173/page', 'http://127.0.0.1:5173', distUrl), true)
  assert.equal(isAllowedNavigationUrl('http://127.0.0.1:5173.evil.test', 'http://127.0.0.1:5173', distUrl), false)

  assert.equal(
    isAuthorizedIpcContext(
      { senderMatchesWindow: true, frameMatchesMainFrame: true, frameUrl: distUrl },
      '',
      distUrl,
    ),
    true,
  )
  assert.equal(
    isAuthorizedIpcContext(
      { senderMatchesWindow: false, frameMatchesMainFrame: true, frameUrl: distUrl },
      '',
      distUrl,
    ),
    false,
  )
  assert.equal(
    isAuthorizedIpcContext(
      { senderMatchesWindow: true, frameMatchesMainFrame: false, frameUrl: distUrl },
      '',
      distUrl,
    ),
    false,
  )
})
