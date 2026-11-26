import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { McpTransportError } from '../../src/index.ts'
import { BoundedStdioClientTransport } from '../../src/transport/bounded-stdio.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

test('BoundedStdioClientTransport aborts immediately on oversized message before unbounded buffering', async () => {
  const transport = new BoundedStdioClientTransport({
    executablePath: process.execPath,
    args: [join(FIXTURES_DIR, 'adversarial-mcp-server.mjs'), 'oversized'],
    cwd: FIXTURES_DIR,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    maxMessageBytes: 1024, // 1 KiB hard bound; fixture sends 200 KiB on tools/call
  })

  const errors: Error[] = []
  let resolveDone!: () => void
  const donePromise = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  transport.onerror = (err) => {
    errors.push(err)
    if (err instanceof McpTransportError && err.message.includes('hard transport limit')) {
      resolveDone()
    }
  }

  await transport.start()
  try {
    await transport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'poison_tool', arguments: {} },
    })

    await Promise.race([
      donePromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for hard transport limit error')), 3000),
      ),
    ])
    assert.ok(errors.some((e) => e instanceof McpTransportError && e.message.includes('hard transport limit')))
  } finally {
    await transport.close()
  }
})
