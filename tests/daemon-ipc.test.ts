import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { normalizeDaemonError, redactSecrets } from '../apps/daemon/src/errors.ts'
import { GhostBotDaemon } from '../apps/daemon/src/server.ts'
import {
  DaemonHealthResponseSchema,
  EmptyParamsSchema,
  ProviderSummarySchema,
} from '../packages/shared-types/ipc.ts'

function requestSocket(
  socketPath: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path,
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    req.end()
  })
}

test('daemon rejects weak authToken and unauthenticated requests', async () => {
  assert.throws(() => new GhostBotDaemon({ authToken: 'short' }), /INVALID_CONFIG|authToken/i)

  const dir = await mkdtemp(join(tmpdir(), 'ghost-bot-daemon-test-'))
  const socketPath = join(dir, 'daemon.sock')
  const token = '0123456789abcdef0123456789abcdef'
  const daemon = new GhostBotDaemon({ authToken: token, socketPath, runtimeMode: 'mock' })
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

    const notFound = await requestSocket(socketPath, '/unknown', token)
    assert.equal(notFound.status, 404)
  } finally {
    await daemon.stop()
    await rm(dir, { recursive: true, force: true })
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
