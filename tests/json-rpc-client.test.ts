import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  JsonRpcClientError,
  JsonRpcStdioClient,
} from '../packages/runtime-adapters/json-rpc-client.ts'
import type {
  JsonRpcNotification,
  JsonRpcServerRequest,
} from '../packages/runtime-adapters/json-rpc-client.ts'

function nodeInlineClient(
  script: string,
  extra?: {
    defaultTimeoutMs?: number
    shutdownGraceMs?: number
    onNotification?: (n: JsonRpcNotification) => void
    onServerRequest?: (r: JsonRpcServerRequest) => Promise<unknown> | unknown
    onMalformedPayload?: (raw: string, err: JsonRpcClientError) => void
  },
) {
  return new JsonRpcStdioClient({
    command: process.execPath,
    args: ['-e', script],
    defaultTimeoutMs: extra?.defaultTimeoutMs ?? 5000,
    shutdownGraceMs: extra?.shutdownGraceMs ?? 1000,
    onNotification: extra?.onNotification,
    onServerRequest: extra?.onServerRequest,
    onMalformedPayload: extra?.onMalformedPayload,
  })
}

test('correlates concurrent out-of-order RPC responses by id', async () => {
  const client = nodeInlineClient(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    const held = [];
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'slow') {
        held.push(msg);
      } else if (msg.method === 'fast') {
        process.stdout.write(JSON.stringify({ id: msg.id, result: { tag: 'fast' } }) + '\\n');
        for (const h of held) {
          process.stdout.write(JSON.stringify({ id: h.id, result: { tag: 'slow' } }) + '\\n');
        }
      }
    });
  `)
  client.start()
  try {
    const pSlow = client.request<{ tag: string }>('slow')
    const pFast = client.request<{ tag: string }>('fast')
    const [fastRes, slowRes] = await Promise.all([pFast, pSlow])
    assert.equal(fastRes.tag, 'fast')
    assert.equal(slowRes.tag, 'slow')
  } finally {
    await client.close()
  }
})

test('delivers streaming notifications and handles server-initiated requests', async () => {
  const notifications: JsonRpcNotification[] = []
  const client = nodeInlineClient(
    `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'start') {
        process.stdout.write(JSON.stringify({ method: 'stream/delta', params: { text: 'hi' } }) + '\\n');
        process.stdout.write(JSON.stringify({ id: 'srv-1', method: 'approval/ask', params: { tool: 'write' } }) + '\\n');
      } else if (msg.id === 'srv-1') {
        process.stdout.write(JSON.stringify({ id: 1, result: { decisionEcho: msg.result.decision } }) + '\\n');
      }
    });
  `,
    {
      onNotification: (n) => notifications.push(n),
      onServerRequest: async (req) => {
        assert.equal(req.method, 'approval/ask')
        return { decision: 'decline' }
      },
    },
  )
  client.start()
  try {
    const res = await client.request<{ decisionEcho: string }>('start')
    assert.equal(res.decisionEcho, 'decline')
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]?.method, 'stream/delta')
  } finally {
    await client.close()
  }
})

test('handles malformed payloads without crashing subsequent valid requests', async () => {
  const malformed: JsonRpcClientError[] = []
  const client = nodeInlineClient(
    `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      process.stdout.write('not-valid-json\\n');
      process.stdout.write('[]\\n');
      process.stdout.write(JSON.stringify({ id: 999, result: {} }) + '\\n');
      process.stdout.write(JSON.stringify({ id: msg.id, result: { ok: true } }) + '\\n');
    });
  `,
    { onMalformedPayload: (_raw, err) => malformed.push(err) },
  )
  client.start()
  try {
    const res = await client.request<{ ok: boolean }>('ping')
    assert.equal(res.ok, true)
    assert.equal(malformed.length, 3)
    assert.ok(malformed.every((e) => e.code === 'MALFORMED_PAYLOAD'))
  } finally {
    await client.close()
  }
})

test('rejects with TIMEOUT when server does not respond in time', async () => {
  const client = nodeInlineClient(`setInterval(() => {}, 10000);`)
  client.start()
  try {
    await assert.rejects(
      () => client.request('hang', undefined, { timeoutMs: 40 }),
      (err: unknown) => err instanceof JsonRpcClientError && err.code === 'TIMEOUT' && err.retryable,
    )
  } finally {
    await client.close()
  }
})

test('rejects with CANCELLED when AbortSignal fires', async () => {
  const client = nodeInlineClient(`setInterval(() => {}, 10000);`)
  client.start()
  try {
    const ac = new AbortController()
    const promise = client.request('hang', undefined, { signal: ac.signal, timeoutMs: 5000 })
    ac.abort()
    await assert.rejects(
      () => promise,
      (err: unknown) => err instanceof JsonRpcClientError && err.code === 'CANCELLED',
    )
  } finally {
    await client.close()
  }
})

test('rejects pending requests with PROCESS_EXITED on unexpected process crash', async () => {
  const client = nodeInlineClient(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', () => process.exit(42));
  `)
  client.start()
  try {
    await assert.rejects(
      () => client.request('boom'),
      (err: unknown) => err instanceof JsonRpcClientError && err.code === 'PROCESS_EXITED',
    )
  } finally {
    await client.close()
  }
})

test('normalizes JSON-RPC error responses', async () => {
  const client = nodeInlineClient(`
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        id: msg.id,
        error: { code: -32602, message: 'Bad params', data: { field: 'model' } }
      }) + '\\n');
    });
  `)
  client.start()
  try {
    await assert.rejects(
      () => client.request('invalid'),
      (err: unknown) =>
        err instanceof JsonRpcClientError &&
        err.code === 'RPC_ERROR' &&
        err.rpcCode === -32602 &&
        err.message === 'Bad params',
    )
  } finally {
    await client.close()
  }
})
